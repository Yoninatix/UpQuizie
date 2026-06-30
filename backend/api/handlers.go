package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// jsonOrNil returns the JSON as a string (so pgx sends it as an untyped value
// Postgres infers as jsonb) or nil. Returning []byte would be encoded as bytea
// and clash with jsonb columns.
func jsonOrNil(r json.RawMessage) interface{} {
	if len(r) == 0 || string(r) == "null" {
		return nil
	}
	return string(r)
}

// ---------- Subjects ----------

func listSubjects(c *gin.Context) {
	role, _ := c.Get("role")
	userID, _ := c.Get("userID")

	// Students only see subjects they're enrolled in.
	q := `SELECT s.id, s.code, s.name, s.department, s.description, s.status,
	             COALESCE(u.full_name,''),
	             (SELECT count(*) FROM subject_enrollments e WHERE e.subject_id=s.id),
	             (SELECT count(*) FROM exams x WHERE x.subject_id=s.id AND x.status='published')
	      FROM subjects s LEFT JOIN users u ON u.id=s.educator_id`
	args := []interface{}{}
	if role == "student" {
		q += ` WHERE s.id IN (SELECT subject_id FROM subject_enrollments WHERE student_id=$1)`
		args = append(args, userID)
	}
	q += ` ORDER BY s.created_at DESC`

	rows, err := db.Query(context.Background(), q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, code, name, status, educator string
		var dept, desc *string
		var students, activeExams int
		rows.Scan(&id, &code, &name, &dept, &desc, &status, &educator, &students, &activeExams)
		out = append(out, gin.H{
			"id": id, "code": code, "name": name, "department": dept, "description": desc,
			"status": status, "educator": educator, "students": students, "active_exams": activeExams,
		})
	}
	c.JSON(200, out)
}

func createSubject(c *gin.Context) {
	var req struct {
		Code        string `json:"code" binding:"required"`
		Name        string `json:"name" binding:"required"`
		Department  string `json:"department"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	userID, _ := c.Get("userID")
	var id string
	err := db.QueryRow(context.Background(),
		`INSERT INTO subjects (code,name,department,description,educator_id)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		req.Code, req.Name, req.Department, req.Description, userID).Scan(&id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func listStudents(c *gin.Context) {
	rows, err := db.Query(context.Background(),
		`SELECT u.id, u.full_name, u.email, u.identifier, e.enrolled_at
		 FROM subject_enrollments e JOIN users u ON u.id=e.student_id
		 WHERE e.subject_id=$1 ORDER BY u.full_name`, c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, name, email string
		var ident *string
		var at time.Time
		rows.Scan(&id, &name, &email, &ident, &at)
		out = append(out, gin.H{"id": id, "full_name": name, "email": email, "identifier": ident, "enrolled_at": at})
	}
	c.JSON(200, out)
}

func enrollStudent(c *gin.Context) {
	subjectID := c.Param("id")
	var req struct {
		Email string `json:"email"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Email == "" {
		c.JSON(400, gin.H{"error": "email required"})
		return
	}
	var studentID string
	err := db.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email=$1 AND role='student'`, strings.ToLower(req.Email)).Scan(&studentID)
	if err != nil {
		c.JSON(404, gin.H{"error": "student not found"})
		return
	}
	_, err = db.Exec(context.Background(),
		`INSERT INTO subject_enrollments (subject_id, student_id) VALUES ($1,$2)
		 ON CONFLICT DO NOTHING`, subjectID, studentID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"ok": true})
}

// ---------- Generated questions (review / approval) ----------

func listGenerated(c *gin.Context) {
	status := c.DefaultQuery("status", "pending")
	rows, err := db.Query(context.Background(),
		`SELECT id, type, difficulty, points, prompt, options, answer, topic, source_ref, status
		 FROM generated_questions WHERE subject_id=$1 AND status=$2 ORDER BY created_at`,
		c.Param("id"), status)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, qtype, diff, prompt, st string
		var pts int
		var options, answer []byte
		var topic, sref *string
		rows.Scan(&id, &qtype, &diff, &pts, &prompt, &options, &answer, &topic, &sref, &st)
		out = append(out, gin.H{"id": id, "type": qtype, "difficulty": diff, "points": pts,
			"prompt": prompt, "options": json.RawMessage(options), "answer": json.RawMessage(answer),
			"topic": topic, "source_ref": sref, "status": st})
	}
	c.JSON(200, out)
}

// deleteAllGenerated clears the selected subject's generated-question bank.
// Questions already copied into exam_questions remain intact.
func deleteAllGenerated(c *gin.Context) {
	result, err := db.Exec(context.Background(),
		`DELETE FROM generated_questions WHERE subject_id=$1`, c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"deleted": result.RowsAffected()})
}

// updateGenerated approves/rejects or edits a generated question.
func updateGenerated(c *gin.Context) {
	var req struct {
		Status     *string         `json:"status"`
		Prompt     *string         `json:"prompt"`
		Difficulty *string         `json:"difficulty"`
		Points     *int            `json:"points"`
		Options    json.RawMessage `json:"options"`
		Answer     json.RawMessage `json:"answer"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	_, err := db.Exec(context.Background(),
		`UPDATE generated_questions SET
		   status     = COALESCE($2, status),
		   prompt     = COALESCE($3, prompt),
		   difficulty = COALESCE($4, difficulty),
		   points     = COALESCE($5, points),
		   options    = COALESCE($6, options),
		   answer     = COALESCE($7, answer)
		 WHERE id=$1`,
		c.Param("gid"), req.Status, req.Prompt, req.Difficulty, req.Points,
		jsonOrNil(req.Options), jsonOrNil(req.Answer))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ---------- Exams ----------

func listExams(c *gin.Context) {
	role, _ := c.Get("role")
	userID, _ := c.Get("userID")
	q := `SELECT e.id, e.title, e.duration_min, e.total_points, e.status, COALESCE(s.name,''), e.subject_id
	      FROM exams e LEFT JOIN subjects s ON s.id=e.subject_id`
	args := []interface{}{}
	if role == "student" {
		q += ` WHERE e.status='published' AND e.subject_id IN
		        (SELECT subject_id FROM subject_enrollments WHERE student_id=$1)`
		args = append(args, userID)
	}
	q += ` ORDER BY e.created_at DESC`
	rows, err := db.Query(context.Background(), q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, title, status, subject, subjectID string
		var dur, pts int
		rows.Scan(&id, &title, &dur, &pts, &status, &subject, &subjectID)
		out = append(out, gin.H{"id": id, "title": title, "duration_min": dur,
			"total_points": pts, "status": status, "subject": subject, "subject_id": subjectID})
	}
	c.JSON(200, out)
}

// createExam builds an exam from approved generated questions.
func createExam(c *gin.Context) {
	var req struct {
		SubjectID   string   `json:"subject_id" binding:"required"`
		Title       string   `json:"title" binding:"required"`
		DurationMin int      `json:"duration_min"`
		AccessCode  string   `json:"access_code"`
		QuestionIDs []string `json:"question_ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.DurationMin == 0 {
		req.DurationMin = 60
	}
	userID, _ := c.Get("userID")
	ctx := context.Background()

	var examID string
	err := db.QueryRow(ctx,
		`INSERT INTO exams (subject_id,title,duration_min,access_code,created_by)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		req.SubjectID, req.Title, req.DurationMin, req.AccessCode, userID).Scan(&examID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Copy approved generated questions into exam_questions.
	pos := 0
	for _, gid := range req.QuestionIDs {
		pos++
		_, err := db.Exec(ctx,
			`INSERT INTO exam_questions (exam_id,type,difficulty,points,prompt,options,answer,topic,source_ref,position)
			 SELECT $1,type,difficulty,points,prompt,options,answer,topic,source_ref,$2
			 FROM generated_questions WHERE id=$3`,
			examID, pos, gid)
		if err == nil {
			db.Exec(ctx, `UPDATE generated_questions SET status='approved' WHERE id=$1`, gid)
		}
	}
	recomputeTotal(examID)
	c.JSON(201, gin.H{"id": examID, "questions_added": pos})
}

func recomputeTotal(examID string) {
	db.Exec(context.Background(),
		`UPDATE exams SET total_points=(SELECT COALESCE(sum(points),0) FROM exam_questions WHERE exam_id=$1) WHERE id=$1`,
		examID)
}

func publishExam(c *gin.Context) {
	_, err := db.Exec(context.Background(),
		`UPDATE exams SET status='published' WHERE id=$1`, c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func getExam(c *gin.Context) {
	var id, title, status string
	var dur, pts int
	var subjectID *string
	err := db.QueryRow(context.Background(),
		`SELECT id, title, status, duration_min, total_points, subject_id FROM exams WHERE id=$1`,
		c.Param("id")).Scan(&id, &title, &status, &dur, &pts, &subjectID)
	if err != nil {
		c.JSON(404, gin.H{"error": "exam not found"})
		return
	}
	c.JSON(200, gin.H{"id": id, "title": title, "status": status,
		"duration_min": dur, "total_points": pts, "subject_id": subjectID})
}

func listExamQuestions(c *gin.Context) {
	role, _ := c.Get("role")
	includeAnswers := role == "educator" || role == "admin"
	rows, err := db.Query(context.Background(),
		`SELECT id, type, difficulty, points, prompt, options, answer, topic, source_ref, position
		 FROM exam_questions WHERE exam_id=$1 ORDER BY position`, c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, qtype, diff, prompt string
		var pts, pos int
		var options, answer []byte
		var topic, sref *string
		rows.Scan(&id, &qtype, &diff, &pts, &prompt, &options, &answer, &topic, &sref, &pos)
		q := gin.H{"id": id, "type": qtype, "difficulty": diff, "points": pts,
			"prompt": prompt, "options": json.RawMessage(options), "topic": topic,
			"source_ref": sref, "position": pos}
		if includeAnswers {
			q["answer"] = json.RawMessage(answer)
		}
		out = append(out, q)
	}
	c.JSON(200, out)
}

// ---------- Attempts & scoring ----------

func startAttempt(c *gin.Context) {
	examID := c.Param("id")
	userID, _ := c.Get("userID")
	var id string
	err := db.QueryRow(context.Background(),
		`INSERT INTO student_exam_attempts (exam_id,student_id) VALUES ($1,$2)
		 ON CONFLICT (exam_id,student_id) DO UPDATE SET started_at=student_exam_attempts.started_at
		 RETURNING id`, examID, userID).Scan(&id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"attempt_id": id})
}

func submitAttempt(c *gin.Context) {
	attemptID := c.Param("aid")
	var req struct {
		Answers []struct {
			QuestionID string          `json:"question_id"`
			Response   json.RawMessage `json:"response"`
		} `json:"answers"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	ctx := context.Background()

	var subjectID *string
	db.QueryRow(ctx, `SELECT e.subject_id FROM exams e
	                  JOIN student_exam_attempts a ON a.exam_id=e.id WHERE a.id=$1`, attemptID).Scan(&subjectID)

	total, maxTotal := 0, 0
	needsReview := false
	topicAgg := map[string][2]int{} // topic -> {correct, total}

	for _, a := range req.Answers {
		var qtype, topic string
		var pts int
		var answer []byte
		err := db.QueryRow(ctx, `SELECT type, points, answer, COALESCE(topic,'') FROM exam_questions WHERE id=$1`, a.QuestionID).
			Scan(&qtype, &pts, &answer, &topic)
		if err != nil {
			continue
		}
		maxTotal += pts
		correct, auto := autoGrade(qtype, answer, a.Response)
		var awardedDB interface{} = nil
		if auto {
			awarded := 0
			if correct {
				awarded = pts
			}
			awardedDB = awarded
			total += awarded
			if topic != "" {
				agg := topicAgg[topic]
				if correct {
					agg[0]++
				}
				agg[1]++
				topicAgg[topic] = agg
			}
		} else {
			needsReview = true
		}
		db.Exec(ctx,
			`INSERT INTO student_answers (attempt_id,question_id,response,awarded_points,is_correct)
			 VALUES ($1,$2,$3,$4,$5)
			 ON CONFLICT (attempt_id,question_id) DO UPDATE
			 SET response=$3, awarded_points=$4, is_correct=$5`,
			attemptID, a.QuestionID, jsonOrNil(a.Response), awardedDB, correct)
	}

	// Persist topic performance for analytics.
	for topic, ct := range topicAgg {
		db.Exec(ctx,
			`INSERT INTO topic_performance (attempt_id, subject_id, topic, correct, total)
			 VALUES ($1,$2,$3,$4,$5)`, attemptID, subjectID, topic, ct[0], ct[1])
	}

	status := "completed"
	if needsReview {
		status = "needs_review"
	}
	db.Exec(ctx, `UPDATE student_exam_attempts SET status=$1, score=$2, total_points=$3, submitted_at=now() WHERE id=$4`,
		status, total, maxTotal, attemptID)
	c.JSON(200, gin.H{"status": status, "score": total, "total_points": maxTotal})
}

func autoGrade(qtype string, answerJSON, responseJSON []byte) (bool, bool) {
	switch qtype {
	case "mcq":
		var ans struct {
			CorrectIndex int `json:"correct_index"`
		}
		var resp struct {
			Index int `json:"index"`
		}
		json.Unmarshal(answerJSON, &ans)
		json.Unmarshal(responseJSON, &resp)
		return resp.Index == ans.CorrectIndex, true
	case "true_false":
		var ans struct {
			Correct bool `json:"correct"`
		}
		var resp struct {
			Value bool `json:"value"`
		}
		json.Unmarshal(answerJSON, &ans)
		json.Unmarshal(responseJSON, &resp)
		return resp.Value == ans.Correct, true
	case "fill_blank":
		var ans struct {
			Accepted []string `json:"accepted"`
		}
		var resp struct {
			Text string `json:"text"`
		}
		json.Unmarshal(answerJSON, &ans)
		json.Unmarshal(responseJSON, &resp)
		for _, a := range ans.Accepted {
			if normalize(a) == normalize(resp.Text) {
				return true, true
			}
		}
		return false, true
	default:
		// essay / matching -> manual or AI-assisted review
		return false, false
	}
}

func normalize(s string) string {
	out := ""
	for _, r := range strings.ToLower(s) {
		if r != ' ' {
			out += string(r)
		}
	}
	return out
}

func getAttempt(c *gin.Context) {
	attemptID := c.Param("aid")
	var examID, status string
	var score, total *int
	err := db.QueryRow(context.Background(),
		`SELECT exam_id, status, score, total_points FROM student_exam_attempts WHERE id=$1`, attemptID).
		Scan(&examID, &status, &score, &total)
	if err != nil {
		c.JSON(404, gin.H{"error": "attempt not found"})
		return
	}
	c.JSON(200, gin.H{"id": attemptID, "exam_id": examID, "status": status,
		"score": score, "total_points": total})
}

// ---------- Analytics (weak-topic detection) ----------

func subjectAnalytics(c *gin.Context) {
	subjectID := c.Param("id")
	rows, err := db.Query(context.Background(),
		`SELECT topic, SUM(correct) AS c, SUM(total) AS t
		 FROM topic_performance WHERE subject_id=$1
		 GROUP BY topic ORDER BY (SUM(correct)::float / NULLIF(SUM(total),0)) ASC`, subjectID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	topics := []gin.H{}
	for rows.Next() {
		var topic string
		var correct, total int
		rows.Scan(&topic, &correct, &total)
		acc := 0.0
		if total > 0 {
			acc = float64(correct) / float64(total) * 100
		}
		topics = append(topics, gin.H{"topic": topic, "correct": correct, "total": total,
			"accuracy": acc, "weak": acc < 60})
	}

	var avgScore *float64
	db.QueryRow(context.Background(),
		`SELECT AVG(score::float / NULLIF(total_points,0)) * 100
		 FROM student_exam_attempts a JOIN exams e ON e.id=a.exam_id
		 WHERE e.subject_id=$1 AND a.status='completed'`, subjectID).Scan(&avgScore)

	c.JSON(200, gin.H{"topics": topics, "average_score": avgScore})
}

// ---------- Admin ----------

func listUsers(c *gin.Context) {
	rows, err := db.Query(context.Background(),
		`SELECT id, email, full_name, role, status, created_at FROM users ORDER BY created_at DESC`)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, email, name, role, status string
		var created time.Time
		rows.Scan(&id, &email, &name, &role, &status, &created)
		out = append(out, gin.H{"id": id, "email": email, "full_name": name,
			"role": role, "status": status, "created_at": created})
	}
	c.JSON(200, out)
}

func updateUser(c *gin.Context) {
	var req struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	_, err := db.Exec(context.Background(),
		`UPDATE users SET role=COALESCE($2,role), status=COALESCE($3,status) WHERE id=$1`,
		c.Param("uid"), req.Role, req.Status)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
