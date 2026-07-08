package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func gradeAnswerWithAI(modelAnswer, studentAnswer string, maxPoints int) (int, float64, error) {
	payload, _ := json.Marshal(gin.H{"model_answer": modelAnswer, "student_answer": studentAnswer, "max_points": maxPoints})
	request, err := http.NewRequest(http.MethodPost, ragURL+"/grade", bytes.NewReader(payload))
	if err != nil {
		return 0, 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return 0, 0, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return 0, 0, fmt.Errorf("AI grader returned %s", response.Status)
	}
	var result struct {
		Points     int     `json:"points"`
		Similarity float64 `json:"similarity"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return 0, 0, err
	}
	if result.Points < 0 {
		result.Points = 0
	}
	if result.Points > maxPoints {
		result.Points = maxPoints
	}
	return result.Points, result.Similarity, nil
}

func listGradingSubmissions(c *gin.Context) {
	role, _ := c.Get("role")
	userID, _ := c.Get("userID")
	query := `SELECT a.id, e.id, e.title, e.exam_mode, COALESCE(s.name,''),
	        u.full_name, COALESCE(u.identifier,''), a.status, a.score,
	        a.total_points, a.submitted_at
	 FROM student_exam_attempts a
	 JOIN exams e ON e.id=a.exam_id
	 JOIN users u ON u.id=a.student_id
	 LEFT JOIN subjects s ON s.id=e.subject_id
	 WHERE a.status <> 'in_progress'`
	args := []interface{}{}
	if sid := c.Query("subject_id"); sid != "" {
		args = append(args, sid)
		query += fmt.Sprintf(` AND e.subject_id=$%d`, len(args))
	}
	// Educators only see submissions for subjects they own.
	if role == "educator" {
		args = append(args, userID)
		query += fmt.Sprintf(` AND e.subject_id IN (SELECT id FROM subjects WHERE educator_id=$%d)`, len(args))
	}
	query += ` ORDER BY a.submitted_at DESC NULLS LAST`
	rows, err := db.Query(context.Background(), query, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var attemptID, examID, title, mode, subject, student, identifier, status string
		var score, total *int
		var submitted interface{}
		if err := rows.Scan(&attemptID, &examID, &title, &mode, &subject, &student,
			&identifier, &status, &score, &total, &submitted); err != nil {
			continue
		}
		out = append(out, gin.H{"attempt_id": attemptID, "exam_id": examID,
			"exam_title": title, "exam_mode": mode, "subject": subject,
			"student_name": student, "identifier": identifier, "status": status,
			"score": score, "total_points": total, "submitted_at": submitted})
	}
	c.JSON(200, out)
}

func reviewAttempt(c *gin.Context) {
	ctx := context.Background()
	attemptID := c.Param("aid")
	var examID, title, mode, student, identifier, status string
	var score, total *int
	if err := db.QueryRow(ctx,
		`SELECT e.id,e.title,e.exam_mode,u.full_name,COALESCE(u.identifier,''),a.status,a.score,a.total_points
		 FROM student_exam_attempts a JOIN exams e ON e.id=a.exam_id
		 JOIN users u ON u.id=a.student_id WHERE a.id=$1`, attemptID).
		Scan(&examID, &title, &mode, &student, &identifier, &status, &score, &total); err != nil {
		c.JSON(404, gin.H{"error": "attempt not found"})
		return
	}
	rows, err := db.Query(ctx,
		`SELECT sa.id,q.id,q.position,q.type,q.prompt,q.options,q.answer,q.points,
		        sa.response,sa.awarded_points,sa.is_correct,sa.feedback
		 FROM exam_questions q LEFT JOIN student_answers sa
		   ON sa.question_id=q.id AND sa.attempt_id=$1
		 WHERE q.exam_id=$2 ORDER BY q.position`, attemptID, examID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	answers := []gin.H{}
	for rows.Next() {
		var answerID, questionID *string
		var position, points int
		var qtype, prompt string
		var options, expected, response []byte
		var awarded *int
		var correct *bool
		var feedback *string
		if err := rows.Scan(&answerID, &questionID, &position, &qtype, &prompt, &options, &expected,
			&points, &response, &awarded, &correct, &feedback); err != nil {
			continue
		}
		answers = append(answers, gin.H{"answer_id": answerID, "question_id": questionID,
			"position": position, "type": qtype, "prompt": prompt, "options": rawJSON(options),
			"expected_answer": rawJSON(expected), "points": points, "response": rawJSON(response),
			"awarded_points": awarded, "is_correct": correct, "feedback": feedback})
	}
	c.JSON(200, gin.H{"attempt_id": attemptID, "exam_id": examID, "exam_title": title,
		"exam_mode": mode, "student_name": student, "identifier": identifier, "status": status,
		"score": score, "total_points": total, "answers": answers})
}

func rawJSON(value []byte) interface{} {
	if len(value) == 0 {
		return nil
	}
	var out interface{}
	if json.Unmarshal(value, &out) != nil {
		return string(value)
	}
	return out
}

func updateAnswerScore(c *gin.Context) {
	ctx := context.Background()
	var req struct {
		Points   int    `json:"points"`
		Feedback string `json:"feedback"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var maxPoints int
	if err := db.QueryRow(ctx,
		`SELECT q.points FROM student_answers sa JOIN exam_questions q ON q.id=sa.question_id
		 WHERE sa.id=$1 AND sa.attempt_id=$2`, c.Param("answerId"), c.Param("aid")).Scan(&maxPoints); err != nil {
		c.JSON(404, gin.H{"error": "answer not found"})
		return
	}
	if req.Points < 0 || req.Points > maxPoints {
		c.JSON(400, gin.H{"error": "points must be between 0 and the question maximum"})
		return
	}
	feedback := req.Feedback
	if feedback == "" {
		feedback = "Teacher reviewed and adjusted this score."
	}
	if _, err := db.Exec(ctx, `UPDATE student_answers SET awarded_points=$1,is_correct=$2,feedback=$3 WHERE id=$4`,
		req.Points, req.Points == maxPoints, feedback, c.Param("answerId")); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	var score, pending int
	db.QueryRow(ctx, `SELECT COALESCE(sum(awarded_points),0),count(*) FILTER (WHERE awarded_points IS NULL)
	 FROM student_answers WHERE attempt_id=$1`, c.Param("aid")).Scan(&score, &pending)
	status := "completed"
	if pending > 0 {
		status = "needs_review"
	}
	db.Exec(ctx, `UPDATE student_exam_attempts SET score=$1,status=$2 WHERE id=$3`, score, status, c.Param("aid"))
	c.JSON(200, gin.H{"ok": true, "score": score, "status": status})
}
