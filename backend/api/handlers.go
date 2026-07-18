package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
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

	// Students only see subjects they're enrolled in; educators only their own.
	q := `SELECT s.id, s.code, s.name, s.department, s.description, s.status,
	             COALESCE(u.full_name,''),
	             (SELECT count(*) FROM subject_enrollments e WHERE e.subject_id=s.id),
	             (SELECT count(*) FROM exams x WHERE x.subject_id=s.id AND x.status='published')
	      FROM subjects s LEFT JOIN users u ON u.id=s.educator_id`
	args := []interface{}{}
	if role == "student" {
		q += ` WHERE s.id IN (SELECT subject_id FROM subject_enrollments WHERE student_id=$1)`
		args = append(args, userID)
	} else if role == "educator" {
		q += ` WHERE s.educator_id=$1`
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

func dropStudent(c *gin.Context) {
	tag, err := db.Exec(context.Background(),
		`DELETE FROM subject_enrollments WHERE subject_id=$1 AND student_id=$2`,
		c.Param("id"), c.Param("studentId"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "student is not enrolled in this subject"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ---------- Generated questions (review / approval) ----------

func listGenerated(c *gin.Context) {
	status := c.DefaultQuery("status", "pending")
	rows, err := db.Query(context.Background(),
		`SELECT id, type, difficulty, points, prompt, options, answer, topic, image_url, source_ref, status
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
		var topic, imageURL, sref *string
		rows.Scan(&id, &qtype, &diff, &pts, &prompt, &options, &answer, &topic, &imageURL, &sref, &st)
		out = append(out, gin.H{"id": id, "type": qtype, "difficulty": diff, "points": pts,
			"prompt": prompt, "options": json.RawMessage(options), "answer": json.RawMessage(answer),
			"topic": topic, "image_url": imageURL, "source_ref": sref, "status": st})
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
		ImageURL   *string         `json:"image_url"`
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
		   image_url  = COALESCE($6, image_url),
		   options    = COALESCE($7, options),
		   answer     = COALESCE($8, answer)
		 WHERE id=$1`,
		c.Param("gid"), req.Status, req.Prompt, req.Difficulty, req.Points,
		req.ImageURL, jsonOrNil(req.Options), jsonOrNil(req.Answer))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func uploadGeneratedQuestionImage(c *gin.Context) {
	questionID := c.Param("gid")
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required (multipart field 'file')"})
		return
	}
	if fileHeader.Size > 8<<20 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "image must be 8 MB or smaller"})
		return
	}
	ext := strings.ToLower(filepath.Ext(fileHeader.Filename))
	allowed := map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true}
	if !allowed[ext] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "image must be jpg, png, webp, or gif"})
		return
	}
	dir := filepath.Join(uploadDir, "question-images")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	name := fmt.Sprintf("%s-%d%s", questionID, time.Now().UnixNano(), ext)
	path := filepath.Join(dir, name)
	if err := c.SaveUploadedFile(fileHeader, path); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save file: " + err.Error()})
		return
	}
	url := "/api/question-images/" + name
	var oldURL *string
	err = db.QueryRow(context.Background(),
		`UPDATE generated_questions SET image_url=$2 WHERE id=$1 RETURNING image_url`,
		questionID, url).Scan(&oldURL)
	if err != nil {
		_ = os.Remove(path)
		c.JSON(http.StatusNotFound, gin.H{"error": "question not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"image_url": url})
}

func removeGeneratedQuestionImage(c *gin.Context) {
	tag, err := db.Exec(context.Background(), `UPDATE generated_questions SET image_url=NULL WHERE id=$1`, c.Param("gid"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "question not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func serveQuestionImage(c *gin.Context) {
	name := filepath.Base(c.Param("name"))
	path := filepath.Join(uploadDir, "question-images", name)
	if _, err := os.Stat(path); err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	c.File(path)
}

func questionBank(c *gin.Context) {
	subjectID := c.Param("id")
	ctx := context.Background()
	groups := []gin.H{}

	examRows, err := db.Query(ctx,
		`SELECT id, title, status, exam_mode, total_points, created_at
		 FROM exams WHERE subject_id=$1 ORDER BY created_at DESC`, subjectID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer examRows.Close()

	for examRows.Next() {
		var examID, title, status, examMode string
		var totalPoints int
		var createdAt time.Time
		if err := examRows.Scan(&examID, &title, &status, &examMode, &totalPoints, &createdAt); err != nil {
			continue
		}
		questionRows, err := db.Query(ctx,
			`SELECT id, type, difficulty, points, prompt, options, answer, topic, image_url, source_ref, position
			 FROM exam_questions WHERE exam_id=$1 ORDER BY position`, examID)
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		questions := []gin.H{}
		for questionRows.Next() {
			var id, qtype, diff, prompt string
			var pts, pos int
			var options, answer []byte
			var topic, imageURL, sref *string
			questionRows.Scan(&id, &qtype, &diff, &pts, &prompt, &options, &answer, &topic, &imageURL, &sref, &pos)
			questions = append(questions, gin.H{"id": id, "type": qtype, "difficulty": diff, "points": pts,
				"prompt": prompt, "options": json.RawMessage(options), "answer": json.RawMessage(answer),
				"topic": topic, "image_url": imageURL, "source_ref": sref, "position": pos})
		}
		questionRows.Close()
		groups = append(groups, gin.H{
			"group_type":   "exam",
			"exam_id":      examID,
			"title":        title,
			"status":       status,
			"exam_mode":    examMode,
			"total_points": totalPoints,
			"created_at":   createdAt,
			"questions":    questions,
		})
	}

	generatedRows, err := db.Query(ctx,
		`SELECT id, type, difficulty, points, prompt, options, answer, topic, image_url, source_ref, status, created_at
		 FROM generated_questions WHERE subject_id=$1 ORDER BY created_at DESC`, subjectID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer generatedRows.Close()
	generated := []gin.H{}
	for generatedRows.Next() {
		var id, qtype, diff, prompt, status string
		var pts int
		var options, answer []byte
		var topic, imageURL, sref *string
		var createdAt time.Time
		generatedRows.Scan(&id, &qtype, &diff, &pts, &prompt, &options, &answer, &topic, &imageURL, &sref, &status, &createdAt)
		generated = append(generated, gin.H{"id": id, "type": qtype, "difficulty": diff, "points": pts,
			"prompt": prompt, "options": json.RawMessage(options), "answer": json.RawMessage(answer),
			"topic": topic, "image_url": imageURL, "source_ref": sref, "status": status, "created_at": createdAt})
	}
	groups = append(groups, gin.H{
		"group_type": "generated",
		"title":      "Generated question bank",
		"questions":  generated,
	})

	c.JSON(200, gin.H{"groups": groups})
}

// ---------- Exams ----------

func listExams(c *gin.Context) {
	role, _ := c.Get("role")
	userID, _ := c.Get("userID")
	q := `SELECT e.id, e.title, e.duration_min, e.total_points, e.status, COALESCE(s.name,''), e.subject_id,
	             e.exam_mode, e.live_state, e.access_code, e.live_started_at, e.starts_at, e.due_at
	      FROM exams e LEFT JOIN subjects s ON s.id=e.subject_id`
	args := []interface{}{}
	if role == "student" {
		q += ` WHERE e.status='published' AND e.subject_id IN
		        (SELECT subject_id FROM subject_enrollments WHERE student_id=$1)`
		args = append(args, userID)
	} else if role == "educator" {
		q += ` WHERE e.subject_id IN (SELECT id FROM subjects WHERE educator_id=$1)`
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
		var id, title, status, subject, subjectID, examMode, liveState string
		var accessCode *string
		var liveStartedAt, startsAt, dueAt *time.Time
		var dur, pts int
		rows.Scan(&id, &title, &dur, &pts, &status, &subject, &subjectID,
			&examMode, &liveState, &accessCode, &liveStartedAt, &startsAt, &dueAt)
		if role == "student" {
			accessCode = nil
		}
		out = append(out, gin.H{"id": id, "title": title, "duration_min": dur,
			"total_points": pts, "status": status, "subject": subject, "subject_id": subjectID,
			"exam_mode": examMode, "live_state": liveState, "access_code": accessCode,
			"live_started_at": liveStartedAt, "starts_at": startsAt, "due_at": dueAt})
	}
	c.JSON(200, out)
}

// createExam builds an exam from generated questions and reusable bank questions.
func createExam(c *gin.Context) {
	type questionRef struct {
		ID     string `json:"id"`
		Source string `json:"source"`
	}
	var req struct {
		SubjectID       string        `json:"subject_id" binding:"required"`
		Title           string        `json:"title" binding:"required"`
		DurationMin     int           `json:"duration_min"`
		ExamMode        string        `json:"exam_mode"`
		AccessCode      string        `json:"access_code"`
		StartsAt        *time.Time    `json:"starts_at"`
		DueAt           *time.Time    `json:"due_at"`
		Publish         bool          `json:"publish"`
		QuestionIDs     []string      `json:"question_ids"`
		BankQuestionIDs []string      `json:"bank_question_ids"`
		QuestionRefs    []questionRef `json:"question_refs"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.DurationMin == 0 {
		req.DurationMin = 60
	}
	if req.ExamMode == "" {
		req.ExamMode = "take_home"
	}
	if req.ExamMode != "take_home" && req.ExamMode != "live" {
		c.JSON(400, gin.H{"error": "exam_mode must be take_home or live"})
		return
	}
	if req.ExamMode == "live" && req.AccessCode == "" {
		c.JSON(400, gin.H{"error": "A live exam requires an access code."})
		return
	}
	userID, _ := c.Get("userID")
	ctx := context.Background()

	var examID string
	err := db.QueryRow(ctx,
		`INSERT INTO exams (subject_id,title,duration_min,exam_mode,access_code,created_by,status,starts_at,due_at)
		 VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,CASE WHEN $7 THEN 'published'::exam_status ELSE 'draft'::exam_status END,$8,$9)
		 RETURNING id`, req.SubjectID, req.Title, req.DurationMin, req.ExamMode, req.AccessCode,
		userID, req.Publish, req.StartsAt, req.DueAt).Scan(&examID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	refs := req.QuestionRefs
	if len(refs) == 0 {
		for _, id := range req.QuestionIDs {
			refs = append(refs, questionRef{ID: id, Source: "generated"})
		}
		for _, id := range req.BankQuestionIDs {
			refs = append(refs, questionRef{ID: id, Source: "bank"})
		}
	}

	added := 0
	for _, ref := range refs {
		if ref.ID == "" {
			continue
		}
		position := added + 1
		var err error
		var rows int64
		switch ref.Source {
		case "", "generated":
			tag, execErr := db.Exec(ctx,
				`INSERT INTO exam_questions (exam_id,type,difficulty,points,prompt,options,answer,topic,image_url,source_ref,position)
				 SELECT $1,type,difficulty,points,prompt,options,answer,topic,image_url,source_ref,$2
				 FROM generated_questions WHERE id=$3 AND subject_id=$4`,
				examID, position, ref.ID, req.SubjectID)
			err = execErr
			rows = tag.RowsAffected()
			if err == nil && rows > 0 {
				db.Exec(ctx, `DELETE FROM generated_questions WHERE id=$1 AND subject_id=$2`, ref.ID, req.SubjectID)
			}
		case "bank", "exam":
			tag, execErr := db.Exec(ctx,
				`INSERT INTO exam_questions (exam_id,type,difficulty,points,prompt,options,answer,topic,image_url,source_ref,position)
				 SELECT $1,q.type,q.difficulty,q.points,q.prompt,q.options,q.answer,q.topic,q.image_url,q.source_ref,$2
				 FROM exam_questions q
				 JOIN exams e ON e.id=q.exam_id
				 WHERE q.id=$3 AND e.subject_id=$4`,
				examID, position, ref.ID, req.SubjectID)
			err = execErr
			rows = tag.RowsAffected()
		default:
			c.JSON(400, gin.H{"error": "question_refs source must be generated or bank"})
			return
		}
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		if rows > 0 {
			added++
		}
	}
	recomputeTotal(examID)
	c.JSON(201, gin.H{"id": examID, "questions_added": added})
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

func updateExam(c *gin.Context) {
	var req struct {
		Title       *string    `json:"title"`
		DurationMin *int       `json:"duration_min"`
		StartsAt    *time.Time `json:"starts_at"`
		DueAt       *time.Time `json:"due_at"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Title != nil && strings.TrimSpace(*req.Title) == "" {
		c.JSON(400, gin.H{"error": "title cannot be empty"})
		return
	}
	if req.DurationMin != nil && *req.DurationMin < 1 {
		c.JSON(400, gin.H{"error": "duration must be at least 1 minute"})
		return
	}
	tag, err := db.Exec(context.Background(),
		`UPDATE exams SET
		   title = COALESCE($2, title),
		   duration_min = COALESCE($3, duration_min),
		   starts_at = $4,
		   due_at = $5
		 WHERE id=$1`,
		c.Param("id"), req.Title, req.DurationMin, req.StartsAt, req.DueAt)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "exam not found"})
		return
	}
	recomputeTotal(c.Param("id"))
	c.JSON(200, gin.H{"ok": true})
}

func setExamActivation(c *gin.Context) {
	var req struct {
		Active *bool `json:"active" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Active == nil {
		c.JSON(400, gin.H{"error": "active must be true or false"})
		return
	}
	status := "closed"
	if *req.Active {
		status = "published"
	}
	tag, err := db.Exec(context.Background(),
		`UPDATE exams SET
		   status=$2,
		   live_state=CASE WHEN $2='published' AND exam_mode='live' AND live_state='ended' THEN 'waiting' ELSE live_state END,
		   live_started_at=CASE WHEN $2='published' AND exam_mode='live' AND live_state='ended' THEN NULL ELSE live_started_at END
		 WHERE id=$1`, c.Param("id"), status)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "exam not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true, "status": status})
}

func deleteExam(c *gin.Context) {
	tag, err := db.Exec(context.Background(),
		`DELETE FROM exams WHERE id=$1`, c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "exam not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func getExam(c *gin.Context) {
	var id, title, status, examMode, liveState string
	var dur, pts int
	var subjectID *string
	var liveStartedAt, startsAt, dueAt *time.Time
	err := db.QueryRow(context.Background(),
		`SELECT id, title, status, duration_min, total_points, subject_id, exam_mode, live_state, live_started_at, starts_at, due_at
		 FROM exams WHERE id=$1`, c.Param("id")).Scan(&id, &title, &status, &dur, &pts,
		&subjectID, &examMode, &liveState, &liveStartedAt, &startsAt, &dueAt)
	if err != nil {
		c.JSON(404, gin.H{"error": "exam not found"})
		return
	}
	c.JSON(200, gin.H{"id": id, "title": title, "status": status,
		"duration_min": dur, "total_points": pts, "subject_id": subjectID,
		"exam_mode": examMode, "live_state": liveState, "live_started_at": liveStartedAt,
		"starts_at": startsAt, "due_at": dueAt})
}

func listExamQuestions(c *gin.Context) {
	role, _ := c.Get("role")
	includeAnswers := role == "educator" || role == "admin"
	if role == "student" {
		userID, _ := c.Get("userID")
		var allowed bool
		if err := db.QueryRow(context.Background(),
			`SELECT (e.exam_mode <> 'take_home' OR e.starts_at IS NULL OR now() >= e.starts_at)
			   AND e.live_state <> 'ended' AND (
			   e.exam_mode <> 'live' OR EXISTS (
			   SELECT 1 FROM student_exam_attempts a
			   WHERE a.exam_id=e.id AND a.student_id=$2 AND a.started_at IS NOT NULL))
			 FROM exams e WHERE e.id=$1`, c.Param("id"), userID).Scan(&allowed); err != nil || !allowed {
			c.JSON(403, gin.H{"error": "This exam is not available yet."})
			return
		}
	}
	rows, err := db.Query(context.Background(),
		`SELECT id, type, difficulty, points, prompt, options, answer, topic, image_url, source_ref, position
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
		var topic, imageURL, sref *string
		rows.Scan(&id, &qtype, &diff, &pts, &prompt, &options, &answer, &topic, &imageURL, &sref, &pos)
		q := gin.H{"id": id, "type": qtype, "difficulty": diff, "points": pts,
			"prompt": prompt, "options": json.RawMessage(options), "topic": topic,
			"image_url": imageURL, "source_ref": sref, "position": pos}
		if includeAnswers {
			q["answer"] = json.RawMessage(answer)
		}
		out = append(out, q)
	}
	c.JSON(200, out)
}

func updateExamQuestion(c *gin.Context) {
	var req struct {
		Prompt   *string         `json:"prompt"`
		Points   *int            `json:"points"`
		ImageURL *string         `json:"image_url"`
		Options  json.RawMessage `json:"options"`
		Answer   json.RawMessage `json:"answer"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Prompt != nil && strings.TrimSpace(*req.Prompt) == "" {
		c.JSON(400, gin.H{"error": "question text cannot be empty"})
		return
	}
	if req.Points != nil && *req.Points < 1 {
		c.JSON(400, gin.H{"error": "points must be at least 1"})
		return
	}
	var examID string
	err := db.QueryRow(context.Background(),
		`UPDATE exam_questions SET
		   prompt = COALESCE($2, prompt),
		   points = COALESCE($3, points),
		   image_url = COALESCE($4, image_url),
		   options = COALESCE($5, options),
		   answer = COALESCE($6, answer)
		 WHERE id=$1 RETURNING exam_id`,
		c.Param("qid"), req.Prompt, req.Points, req.ImageURL, jsonOrNil(req.Options), jsonOrNil(req.Answer)).Scan(&examID)
	if err != nil {
		c.JSON(404, gin.H{"error": "question not found"})
		return
	}
	recomputeTotal(examID)
	c.JSON(200, gin.H{"ok": true})
}

func examAvailableToStudent(examMode, liveState string, startsAt *time.Time) bool {
	if examMode == "take_home" && startsAt != nil && time.Now().Before(*startsAt) {
		return false
	}
	if examMode == "live" && liveState == "ended" {
		return false
	}
	return true
}

// ---------- Attempts & scoring ----------

// startAttempt begins a new attempt, or resumes the caller's own in-progress
// one (e.g. after a page refresh). Once an attempt has been submitted
// (completed/needs_review), students may not start a new one for the same
// exam — each exam may be taken exactly once.
func startAttempt(c *gin.Context) {
	examID := c.Param("id")
	userID, _ := c.Get("userID")
	ctx := context.Background()
	var req struct {
		Code string `json:"code"`
	}
	_ = c.ShouldBindJSON(&req)

	var examMode, liveState, examStatus string
	var durationMin int
	var accessCode *string
	var liveStartedAt *time.Time
	var startsAt *time.Time
	if err := db.QueryRow(ctx, `SELECT exam_mode, live_state, status, access_code, duration_min, live_started_at, starts_at FROM exams WHERE id=$1`, examID).
		Scan(&examMode, &liveState, &examStatus, &accessCode, &durationMin, &liveStartedAt, &startsAt); err != nil {
		c.JSON(404, gin.H{"error": "exam not found"})
		return
	}
	if examStatus != "published" {
		c.JSON(409, gin.H{"error": "This exam is not available."})
		return
	}
	if !examAvailableToStudent(examMode, liveState, startsAt) {
		c.JSON(409, gin.H{"error": "This exam is not open yet.", "starts_at": startsAt})
		return
	}
	if accessCode != nil && *accessCode != "" && req.Code != *accessCode {
		c.JSON(403, gin.H{"error": "Invalid access code."})
		return
	}
	var liveEndsAt *time.Time
	if examMode == "live" && liveStartedAt != nil {
		endsAt := liveStartedAt.Add(time.Duration(durationMin) * time.Minute)
		liveEndsAt = &endsAt
		if !time.Now().Before(endsAt) {
			db.Exec(ctx, `UPDATE exams SET live_state='ended' WHERE id=$1 AND live_state='started'`, examID)
			c.JSON(409, gin.H{"error": "This live exam has ended."})
			return
		}
	}

	var id, status string
	var startedAt *time.Time
	err := db.QueryRow(ctx,
		`SELECT id, status, started_at FROM student_exam_attempts WHERE exam_id=$1 AND student_id=$2`,
		examID, userID).Scan(&id, &status, &startedAt)
	if err == nil {
		if status != "in_progress" {
			c.JSON(409, gin.H{"error": "You have already taken this exam.", "attempt_id": id})
			return
		}
		waiting := examMode == "live" && liveState != "started" && startedAt == nil
		if examMode == "live" && liveState == "started" && startedAt == nil {
			now := time.Now()
			db.QueryRow(ctx, `UPDATE student_exam_attempts SET started_at=$1 WHERE id=$2 RETURNING started_at`, now, id).Scan(&startedAt)
		}
		c.JSON(200, gin.H{"attempt_id": id, "started_at": startedAt, "waiting": waiting, "ends_at": liveEndsAt})
		return
	}

	startNow := examMode != "live" || liveState == "started"
	if err := db.QueryRow(ctx,
		`INSERT INTO student_exam_attempts (exam_id,student_id,started_at)
		 VALUES ($1,$2,CASE WHEN $3 THEN now() ELSE NULL END) RETURNING id, started_at`,
		examID, userID, startNow).Scan(&id, &startedAt); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"attempt_id": id, "started_at": startedAt, "waiting": !startNow, "ends_at": liveEndsAt})
}

func submitAttempt(c *gin.Context) {
	attemptID := c.Param("aid")
	userID, _ := c.Get("userID")
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

	var ownerID, attemptStatus string
	var attemptStartedAt *time.Time
	if err := db.QueryRow(ctx,
		`SELECT student_id, status, started_at FROM student_exam_attempts WHERE id=$1`, attemptID).
		Scan(&ownerID, &attemptStatus, &attemptStartedAt); err != nil {
		c.JSON(404, gin.H{"error": "attempt not found"})
		return
	}
	if ownerID != userID {
		c.JSON(403, gin.H{"error": "not your exam attempt"})
		return
	}
	if attemptStatus != "in_progress" {
		c.JSON(409, gin.H{"error": "This exam has already been submitted."})
		return
	}
	if attemptStartedAt == nil {
		c.JSON(409, gin.H{"error": "The teacher has not started this live exam yet."})
		return
	}

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
		correct := false
		var awardedDB interface{} = nil
		feedback := ""
		if isBlankResponse(qtype, a.Response) {
			awardedDB = 0
			feedback = "No answer submitted. Automatic score: 0."
			if topic != "" {
				agg := topicAgg[topic]
				agg[1]++
				topicAgg[topic] = agg
			}
		} else if correct, auto := autoGrade(qtype, answer, a.Response); auto {
			awarded := 0
			if correct {
				awarded = pts
			}
			awardedDB = awarded
			if correct {
				feedback = "Automatic grading: the response matched the expected answer."
			} else {
				feedback = "Automatic grading: the response did not match the expected answer."
			}
			total += awarded
			if topic != "" {
				agg := topicAgg[topic]
				if correct {
					agg[0]++
				}
				agg[1]++
				topicAgg[topic] = agg
			}
		} else if awarded, similarity, err := gradeAnswerWithAI(string(answer), string(a.Response), pts); err == nil {
			awardedDB = awarded
			total += awarded
			correct = awarded == pts
			feedback = fmt.Sprintf("AI-assisted score based on semantic similarity: %.1f%%. Teacher review is recommended.", similarity*100)
		} else {
			needsReview = true
			feedback = "AI grading was unavailable. This answer requires teacher review."
		}
		db.Exec(ctx,
			`INSERT INTO student_answers (attempt_id,question_id,response,awarded_points,is_correct,feedback)
			 VALUES ($1,$2,$3,$4,$5,$6)
			 ON CONFLICT (attempt_id,question_id) DO UPDATE
			 SET response=$3, awarded_points=$4, is_correct=$5, feedback=$6`,
			attemptID, a.QuestionID, jsonOrNil(a.Response), awardedDB, correct, feedback)
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
	tag, err := db.Exec(ctx,
		`UPDATE student_exam_attempts SET status=$1, score=$2, total_points=$3, submitted_at=now()
		  WHERE id=$4 AND status='in_progress'`,
		status, total, maxTotal, attemptID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		// Lost a race with a concurrent submit (e.g. two open tabs).
		c.JSON(409, gin.H{"error": "This exam has already been submitted."})
		return
	}
	c.JSON(200, gin.H{"status": status, "score": total, "total_points": maxTotal})
}

func isBlankResponse(qtype string, responseJSON []byte) bool {
	trimmed := strings.TrimSpace(string(responseJSON))
	if trimmed == "" || trimmed == "null" || trimmed == "{}" || trimmed == "[]" {
		return true
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(responseJSON, &raw); err != nil {
		return false
	}
	switch qtype {
	case "mcq":
		_, ok := raw["index"]
		return !ok
	case "true_false":
		_, ok := raw["value"]
		return !ok
	case "fill_blank", "short_answer", "essay":
		var resp struct {
			Text string `json:"text"`
		}
		json.Unmarshal(responseJSON, &resp)
		return strings.TrimSpace(resp.Text) == ""
	case "matching":
		var resp struct {
			Pairs [][]int `json:"pairs"`
		}
		json.Unmarshal(responseJSON, &resp)
		return len(resp.Pairs) == 0
	default:
		if text, ok := raw["text"]; ok {
			var value string
			json.Unmarshal(text, &value)
			return strings.TrimSpace(value) == ""
		}
		return len(raw) == 0
	}
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
	case "matching":
		var ans struct {
			Pairs [][]int `json:"pairs"`
		}
		var resp struct {
			Pairs [][]int `json:"pairs"`
		}
		json.Unmarshal(answerJSON, &ans)
		json.Unmarshal(responseJSON, &resp)
		if len(ans.Pairs) == 0 {
			// Malformed stored answer; leave it for manual/AI review.
			return false, false
		}
		want := map[int]int{}
		for _, pair := range ans.Pairs {
			if len(pair) == 2 {
				want[pair[0]] = pair[1]
			}
		}
		if len(resp.Pairs) != len(want) {
			return false, true
		}
		seenLeft := map[int]bool{}
		for _, pair := range resp.Pairs {
			if len(pair) != 2 || seenLeft[pair[0]] {
				return false, true
			}
			seenLeft[pair[0]] = true
			if expected, ok := want[pair[0]]; !ok || expected != pair[1] {
				return false, true
			}
		}
		return true, true
	default:
		// essay -> manual or AI-assisted review
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
		`SELECT id, email, full_name, role, identifier, status, created_at FROM users ORDER BY created_at DESC`)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, email, name, role, status string
		var identifier *string
		var created time.Time
		rows.Scan(&id, &email, &name, &role, &identifier, &status, &created)
		out = append(out, gin.H{"id": id, "email": email, "full_name": name,
			"role": role, "identifier": identifier, "status": status, "created_at": created})
	}
	c.JSON(200, out)
}

func updateUser(c *gin.Context) {
	var req struct {
		FullName   *string `json:"full_name"`
		Email      *string `json:"email"`
		Identifier *string `json:"identifier"`
		Role       *string `json:"role"`
		Status     *string `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Role != nil && *req.Role != "student" && *req.Role != "educator" && *req.Role != "admin" {
		c.JSON(400, gin.H{"error": "role must be student, educator, or admin"})
		return
	}
	if req.Status != nil && *req.Status != "active" && *req.Status != "inactive" && *req.Status != "pending" {
		c.JSON(400, gin.H{"error": "status must be active, inactive, or pending"})
		return
	}
	if req.FullName != nil && strings.TrimSpace(*req.FullName) == "" {
		c.JSON(400, gin.H{"error": "full_name cannot be empty"})
		return
	}
	if req.Email != nil && strings.TrimSpace(*req.Email) == "" {
		c.JSON(400, gin.H{"error": "email cannot be empty"})
		return
	}
	tag, err := db.Exec(context.Background(),
		`UPDATE users SET full_name=COALESCE($2,full_name), email=COALESCE($3,email),
		 identifier=NULLIF(COALESCE($4,identifier),''),
		 role=COALESCE($5::user_role,role), status=COALESCE($6::user_status,status)
		 WHERE id=$1`,
		c.Param("uid"), req.FullName, req.Email, req.Identifier, req.Role, req.Status)
	if err != nil {
		if strings.Contains(err.Error(), "users_email_key") {
			c.JSON(409, gin.H{"error": "That email is already in use by another account."})
			return
		}
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "user not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func deleteUser(c *gin.Context) {
	adminID, _ := c.Get("userID")
	if fmt.Sprint(adminID) == c.Param("uid") {
		c.JSON(400, gin.H{"error": "You cannot delete your own account."})
		return
	}
	tag, err := db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, c.Param("uid"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "user not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
