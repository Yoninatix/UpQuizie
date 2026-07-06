package main

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"
)

// studentPerformance returns the signed-in student's own results and weak topics.
func studentPerformance(c *gin.Context) {
	userID, _ := c.Get("userID")
	ctx := context.Background()

	// Recent attempts
	rows, err := db.Query(ctx,
		`SELECT a.id, e.id, e.title, COALESCE(s.name,''), a.score, a.total_points, a.status, a.submitted_at
		 FROM student_exam_attempts a
		 JOIN exams e ON e.id = a.exam_id
		 LEFT JOIN subjects s ON s.id = e.subject_id
		 WHERE a.student_id = $1
		 ORDER BY a.submitted_at DESC NULLS LAST, a.started_at DESC
		 LIMIT 20`, userID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	attempts := []gin.H{}
	attemptByID := map[string]gin.H{}
	for rows.Next() {
		var id, examID, title, subject, status string
		var score, total *int
		var submitted *time.Time
		rows.Scan(&id, &examID, &title, &subject, &score, &total, &status, &submitted)
		attempt := gin.H{
			"id": id, "exam_id": examID, "title": title, "subject": subject, "score": score,
			"total_points": total, "status": status, "submitted_at": submitted,
			"topic_mastery": []gin.H{}, "weak_topics": []gin.H{},
		}
		attempts = append(attempts, attempt)
		attemptByID[id] = attempt
	}

	// Average percentage across completed attempts
	var avg *float64
	db.QueryRow(ctx,
		`SELECT AVG(score::float / NULLIF(total_points,0)) * 100
		 FROM student_exam_attempts
		 WHERE student_id = $1 AND status = 'completed'`, userID).Scan(&avg)

	// Per-exam topic mastery is calculated directly from graded answers. This
	// means automatic grades, AI-assisted grades, and teacher corrections are
	// all reflected without relying on a stale summary table.
	trows, err := db.Query(ctx,
		`SELECT a.id, q.topic, COALESCE(SUM(sa.awarded_points),0), SUM(q.points)
		 FROM student_exam_attempts a
		 JOIN student_answers sa ON sa.attempt_id=a.id
		 JOIN exam_questions q ON q.id=sa.question_id
		 WHERE a.student_id=$1 AND a.status<>'in_progress'
		   AND sa.awarded_points IS NOT NULL AND q.topic IS NOT NULL AND btrim(q.topic)<>''
		 GROUP BY a.id,q.topic ORDER BY a.id,q.topic`, userID)
	if err == nil {
		defer trows.Close()
		for trows.Next() {
			var attemptID, topic string
			var earned, total int
			trows.Scan(&attemptID, &topic, &earned, &total)
			acc := 0.0
			if total > 0 {
				acc = float64(earned) / float64(total) * 100
			}
			item := topicMasteryItem(topic, earned, total, acc)
			if attempt, ok := attemptByID[attemptID]; ok {
				mastery := attempt["topic_mastery"].([]gin.H)
				attempt["topic_mastery"] = append(mastery, item)
				if acc < 60 {
					weak := attempt["weak_topics"].([]gin.H)
					attempt["weak_topics"] = append(weak, item)
				}
			}
		}
	}

	// Overall mastery combines every graded question across all completed
	// quizzes, weighted by the points available in each topic.
	overall := []gin.H{}
	orows, err := db.Query(ctx,
		`SELECT q.topic, COALESCE(SUM(sa.awarded_points),0), SUM(q.points)
		 FROM student_exam_attempts a
		 JOIN student_answers sa ON sa.attempt_id=a.id
		 JOIN exam_questions q ON q.id=sa.question_id
		 WHERE a.student_id=$1 AND a.status<>'in_progress'
		   AND sa.awarded_points IS NOT NULL AND q.topic IS NOT NULL AND btrim(q.topic)<>''
		 GROUP BY q.topic ORDER BY (SUM(sa.awarded_points)::float / NULLIF(SUM(q.points),0)) ASC`, userID)
	if err == nil {
		defer orows.Close()
		for orows.Next() {
			var topic string
			var earned, total int
			orows.Scan(&topic, &earned, &total)
			acc := 0.0
			if total > 0 {
				acc = float64(earned) / float64(total) * 100
			}
			overall = append(overall, topicMasteryItem(topic, earned, total, acc))
		}
	}
	weak := []gin.H{}
	for _, item := range overall {
		if item["weak"].(bool) {
			weak = append(weak, item)
		}
	}
	c.JSON(200, gin.H{"average_score": avg, "attempts": attempts,
		"topic_mastery": overall, "weak_topics": weak})
}

func topicMasteryItem(topic string, earned, total int, accuracy float64) gin.H {
	level := "mastered"
	if accuracy < 60 {
		level = "weak"
	} else if accuracy < 80 {
		level = "developing"
	}
	return gin.H{"topic": topic, "earned_points": earned, "total_points": total,
		"accuracy": accuracy, "weak": accuracy < 60, "level": level}
}

// verifyExamAccess checks an access code before a student starts a protected exam.
func verifyExamAccess(c *gin.Context) {
	var req struct {
		Code string `json:"code"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var code *string
	if err := db.QueryRow(context.Background(),
		`SELECT access_code FROM exams WHERE id=$1`, c.Param("id")).Scan(&code); err != nil {
		c.JSON(404, gin.H{"error": "exam not found"})
		return
	}
	if code == nil || *code == "" || *code == req.Code {
		c.JSON(200, gin.H{"ok": true})
		return
	}
	c.JSON(403, gin.H{"ok": false, "error": "invalid access code"})
}

// examAccessInfo reports whether an exam needs an access code (without revealing it).
func examAccessInfo(c *gin.Context) {
	var code *string
	var mode, liveState string
	if err := db.QueryRow(context.Background(),
		`SELECT access_code, exam_mode, live_state FROM exams WHERE id=$1`, c.Param("id")).Scan(&code, &mode, &liveState); err != nil {
		c.JSON(404, gin.H{"error": "exam not found"})
		return
	}
	c.JSON(200, gin.H{"requires_code": code != nil && *code != "", "exam_mode": mode, "live_state": liveState})
}
