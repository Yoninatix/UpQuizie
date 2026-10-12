package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// uploadDocument accepts a multipart file, stores it in the shared uploads
// volume, records metadata, and asks the RAG service to extract + chunk + embed.
func uploadDocument(c *gin.Context) {
	subjectID := c.Param("id")
	userID, _ := c.Get("userID")

	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(400, gin.H{"error": "file is required (multipart field 'file')"})
		return
	}
	moduleLabel := normalizeModuleLabel(c.PostForm("module_label"))

	docID := uuid.NewString()
	ext := strings.ToLower(filepath.Ext(fileHeader.Filename))
	if !supportedDocumentExt(ext) {
		c.JSON(400, gin.H{"error": "unsupported file type. Upload PDF, DOC, DOCX, PPT, PPTX, XLSX, ODT, HTML, RTF, TXT, MD, CSV, PNG, JPG, or JPEG."})
		return
	}
	storedName := fmt.Sprintf("%s%s", docID, ext)
	storedPath := filepath.Join(uploadDir, storedName)

	if err := c.SaveUploadedFile(fileHeader, storedPath); err != nil {
		c.JSON(500, gin.H{"error": "could not save file: " + err.Error()})
		return
	}

	ctx := context.Background()
	_, err = db.Exec(ctx,
		`INSERT INTO uploaded_documents (id, subject_id, uploaded_by, filename, file_type, module_label, file_path, size_bytes, status)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing')`,
		docID, subjectID, userID, fileHeader.Filename, strings.TrimPrefix(ext, "."), moduleLabel, storedPath, fileHeader.Size)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	go func() {
		body, _ := json.Marshal(gin.H{
			"document_id": docID,
			"subject_id":  subjectID,
			"file_path":   storedPath,
			"filename":    fileHeader.Filename,
		})
		client := http.Client{Timeout: 5 * time.Minute}
		resp, err := client.Post(ragURL+"/process", "application/json", bytes.NewReader(body))
		status := "ready"
		errMsg := ""
		if err != nil {
			status, errMsg = "error", err.Error()
		} else {
			if resp.StatusCode >= 300 {
				errMsg = "rag process failed"
				if bodyBytes, readErr := io.ReadAll(resp.Body); readErr == nil {
					var body struct {
						Error string `json:"error"`
					}
					if json.Unmarshal(bodyBytes, &body) == nil && strings.TrimSpace(body.Error) != "" {
						errMsg = "rag process failed: " + strings.TrimSpace(body.Error)
					}
				}
				status = "error"
			}
			resp.Body.Close()
		}
		cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		db.Exec(cctx, `UPDATE uploaded_documents SET status=$1, error=$2 WHERE id=$3`, status, errMsg, docID)
	}()

	c.JSON(201, gin.H{"id": docID, "status": "processing"})
}

func supportedDocumentExt(ext string) bool {
	allowed := map[string]bool{
		".pdf": true, ".doc": true, ".docx": true, ".ppt": true, ".pptx": true,
		".xlsx": true, ".odt": true, ".html": true, ".htm": true, ".rtf": true,
		".txt": true, ".md": true, ".csv": true, ".png": true, ".jpg": true, ".jpeg": true,
	}
	return allowed[strings.ToLower(ext)]
}

func listDocuments(c *gin.Context) {
	rows, err := db.Query(context.Background(),
		`SELECT id, filename, file_type, module_label, size_bytes, status, error, created_at
		 FROM uploaded_documents WHERE subject_id=$1 ORDER BY module_label, created_at DESC`, c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, filename, moduleLabel, status string
		var ftype, errMsg *string
		var size int64
		var created time.Time
		rows.Scan(&id, &filename, &ftype, &moduleLabel, &size, &status, &errMsg, &created)
		out = append(out, gin.H{"id": id, "filename": filename, "file_type": ftype,
			"module_label": moduleLabel, "size_bytes": size, "status": status, "error": errMsg, "created_at": created})
	}
	c.JSON(200, out)
}

func normalizeModuleLabel(value string) string {
	value = strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if value == "" {
		return "Module 1"
	}
	if len(value) > 80 {
		value = value[:80]
	}
	return value
}

func renameModule(c *gin.Context) {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	from := normalizeModuleLabel(req.From)
	to := normalizeModuleLabel(req.To)
	if strings.TrimSpace(req.To) == "" {
		c.JSON(400, gin.H{"error": "module name is required"})
		return
	}
	if from == to {
		c.JSON(200, gin.H{"ok": true, "updated": 0, "module_label": to})
		return
	}

	tag, err := db.Exec(context.Background(),
		`UPDATE uploaded_documents
		 SET module_label=$3
		 WHERE subject_id=$1 AND module_label=$2`,
		c.Param("id"), from, to)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "updated": tag.RowsAffected(), "module_label": to})
}

// generationOptions supplies non-free-text generation controls. Topic/focus
// suggestions come only from title/header-like lines in ready uploaded content.
func generationOptions(c *gin.Context) {
	subjectID := c.Param("id")
	documentIDs := []string{}
	requestedDocuments := c.Query("document_ids")
	if requestedDocuments == "" {
		requestedDocuments = c.Query("document_id") // backward compatibility
	}
	seenDocuments := map[string]bool{}
	for _, id := range strings.Split(requestedDocuments, ",") {
		id = strings.TrimSpace(id)
		if id != "" && !seenDocuments[id] {
			documentIDs = append(documentIDs, id)
			seenDocuments[id] = true
		}
	}

	rows, err := db.Query(context.Background(),
		`SELECT id, filename, module_label FROM uploaded_documents
		 WHERE subject_id=$1 AND status='ready' ORDER BY module_label, created_at DESC`, subjectID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	documents := []gin.H{}
	documentNames := map[string]string{}
	for rows.Next() {
		var id, filename, moduleLabel string
		if err := rows.Scan(&id, &filename, &moduleLabel); err == nil {
			documents = append(documents, gin.H{"id": id, "filename": filename, "module_label": moduleLabel})
			documentNames[id] = filename
		}
	}
	rows.Close()
	for _, documentID := range documentIDs {
		if _, ok := documentNames[documentID]; !ok {
			c.JSON(400, gin.H{"error": "selected document is not ready or does not belong to this subject"})
			return
		}
	}

	type topicScore struct {
		value string
		score int
	}
	topicMap := map[string]topicScore{}
	camelCase := regexp.MustCompile(`([a-z])([A-Z])`)
	nonTopicChars := regexp.MustCompile(`[^a-z0-9]+`)
	numericTopicPart := regexp.MustCompile(`^[0-9]+$`)
	genericTopicPatterns := regexp.MustCompile(`(?i)^(?:introduction|overview|summary|conclusion|lesson|chapter|section|unit|part|slide|objective|objectives|goal|goals|review|example|exercise|problem|notes|background|topic|content|material|materials)$`)
	chapterPrefix := regexp.MustCompile(`(?i)^(?:chapter|lesson|module|unit|section)\s+[0-9ivxlcdm]+(?:\s*[:.)-]\s*|\s+)`)
	numberedPrefix := regexp.MustCompile(`^[0-9]+(?:\.[0-9]+)*[.)-]?\s+`)
	markdownHeading := regexp.MustCompile(`^(?:#{1,6})\s+(.+)$`)
	labelHeading := regexp.MustCompile(`(?i)^(?:title|header)\s*:\s*(.+)$`)
	inlineLabelHeading := regexp.MustCompile(`(?i)(?:^|\n|[.!?]\s+)(?:title|header)\s*:\s*([^.!?\n]{3,100})`)
	inlineChapterHeading := regexp.MustCompile(`(?i)(?:^|\n|[.!?]\s+)(?:chapter|lesson|module|unit|section)\s+[0-9ivxlcdm]+(?:\s*[:.)-]\s*|\s+)([^.!?\n]{3,120})`)
	chapterHeading := regexp.MustCompile(`(?i)^(?:chapter|lesson|module|unit|section)\s+[0-9ivxlcdm]+(?:\s*[:.)-]\s*|\s+)(.+)$`)
	numberedHeading := regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)*[.)]\s+[A-Z][A-Za-z0-9() /&+_,'-]{2,100})$`)
	hasCapitalLetter := regexp.MustCompile(`[A-Z]`)
	sentenceStarter := regexp.MustCompile(`\s+(?:When|The|A|An|This|These|Those|It|In|On|For|Before|After|However|Electrons?|Atoms?|Noble|Mendeleev|Bohr)\b.*$`)
	normalizeTopicValue := func(value string) string {
		value = camelCase.ReplaceAllString(value, `$1 $2`)
		value = strings.TrimSpace(value)
		value = chapterPrefix.ReplaceAllString(value, "")
		value = numberedPrefix.ReplaceAllString(value, "")
		value = strings.Trim(value, "#:.- ")
		value = strings.Join(strings.Fields(value), " ")
		return value
	}
	makeTopicKey := func(value string) string {
		key := strings.ToLower(value)
		key = nonTopicChars.ReplaceAllString(key, " ")
		key = strings.ReplaceAll(key, "left most", "leftmost")
		key = strings.ReplaceAll(key, "right most", "rightmost")
		keyParts := []string{}
		for _, part := range strings.Fields(key) {
			if part == "given" || part == "solution" || part == "example" || part == "page" || part == "slide" ||
				part == "modified" || numericTopicPart.MatchString(part) {
				continue
			}
			keyParts = append(keyParts, part)
		}
		return strings.Join(keyParts, " ")
	}
	isGenericTopic := func(value string) bool {
		if len(value) < 3 || len(value) > 100 || len(strings.Fields(value)) > 10 {
			return true
		}
		return genericTopicPatterns.MatchString(value)
	}
	isTitleCaseLine := func(value string) bool {
		words := strings.Fields(value)
		if len(words) == 0 {
			return false
		}
		titleWords := 0
		for _, word := range words {
			word = strings.Trim(word, "([]{}:,-")
			if word == "" {
				continue
			}
			r := []rune(word)[0]
			if r >= 'A' && r <= 'Z' {
				titleWords++
			}
		}
		return titleWords >= 1 && titleWords*2 >= len(words)
	}
	isHeaderLine := func(line string) (string, bool) {
		line = strings.TrimSpace(line)
		if line == "" || len(line) > 140 || strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") {
			return "", false
		}
		if strings.ContainsAny(line, ".!?;") && !numberedHeading.MatchString(line) {
			return "", false
		}
		if match := markdownHeading.FindStringSubmatch(line); len(match) > 1 {
			return match[1], true
		}
		if match := labelHeading.FindStringSubmatch(line); len(match) > 1 {
			return match[1], true
		}
		if match := chapterHeading.FindStringSubmatch(line); len(match) > 1 {
			return match[1], true
		}
		if match := numberedHeading.FindStringSubmatch(line); len(match) > 1 {
			return match[1], true
		}
		trimmed := strings.Trim(line, ":")
		if strings.ToUpper(trimmed) == trimmed && hasCapitalLetter.MatchString(trimmed) && len(strings.Fields(trimmed)) <= 10 {
			return trimmed, true
		}
		if len(strings.Fields(trimmed)) <= 8 && isTitleCaseLine(trimmed) {
			return trimmed, true
		}
		return "", false
	}
	cleanInlineTitle := func(value string) string {
		value = sentenceStarter.ReplaceAllString(strings.TrimSpace(value), "")
		words := strings.Fields(value)
		if len(words) > 10 {
			words = words[:10]
		}
		return strings.Join(words, " ")
	}
	repeatedHeadings := func(content string) []string {
		raw := strings.Fields(content)
		words := make([]string, 0, len(raw))
		for _, word := range raw {
			word = strings.Trim(word, ".,;:!?()[]{}")
			if word != "" {
				words = append(words, word)
			}
		}
		out := []string{}
		seen := map[string]bool{}
		for i := 0; i < len(words); i++ {
			for size := 1; size <= 8 && i+2*size <= len(words); size++ {
				left := strings.Join(words[i:i+size], " ")
				right := strings.Join(words[i+size:i+2*size], " ")
				if left == right && isTitleCaseLine(left) && !seen[strings.ToLower(left)] {
					out = append(out, left)
					seen[strings.ToLower(left)] = true
				}
			}
		}
		return out
	}

	addTopic := func(value string, score int) {
		value = normalizeTopicValue(value)
		if isGenericTopic(value) {
			return
		}
		key := makeTopicKey(value)
		if len(key) < 3 {
			return
		}
		if old, ok := topicMap[key]; !ok || score > old.score {
			topicMap[key] = topicScore{value: value, score: score}
		}
	}

	args := []interface{}{subjectID}
	docFilter := ""
	if len(documentIDs) > 0 {
		placeholders := make([]string, 0, len(documentIDs))
		for _, documentID := range documentIDs {
			args = append(args, documentID)
			placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
		}
		docFilter = " AND document_id IN (" + strings.Join(placeholders, ",") + ")"
	}

	chunkQuery := `SELECT content FROM document_chunks WHERE subject_id=$1`
	chunkQuery += docFilter
	chunkQuery += ` ORDER BY chunk_index LIMIT 30`
	chunkRows, err := db.Query(context.Background(), chunkQuery, args...)
	if err == nil {
		lineNumber := 0
		for chunkRows.Next() {
			var content string
			if chunkRows.Scan(&content) != nil {
				continue
			}
			for _, match := range inlineLabelHeading.FindAllStringSubmatch(content, -1) {
				if len(match) > 1 {
					addTopic(match[1], 1200-lineNumber)
				}
			}
			for _, match := range inlineChapterHeading.FindAllStringSubmatch(content, -1) {
				if len(match) > 1 {
					addTopic(cleanInlineTitle(match[1]), 1100-lineNumber)
				}
			}
			for _, title := range repeatedHeadings(content) {
				addTopic(title, 900-lineNumber)
			}
			for _, line := range strings.Split(content, "\n") {
				if title, ok := isHeaderLine(line); ok {
					addTopic(title, 1000-lineNumber)
				}
				lineNumber++
			}
		}
		chunkRows.Close()
	}

	topics := make([]topicScore, 0, len(topicMap))
	for _, item := range topicMap {
		topics = append(topics, item)
	}
	sort.Slice(topics, func(i, j int) bool {
		if topics[i].score == topics[j].score {
			return strings.ToLower(topics[i].value) < strings.ToLower(topics[j].value)
		}
		return topics[i].score > topics[j].score
	})
	values := []string{}
	for i, item := range topics {
		if i >= 30 {
			break
		}
		values = append(values, item.value)
	}
	c.JSON(200, gin.H{"documents": documents, "topics": values})
}

// deleteDocument removes a learning material: the DB row (cascades chunks),
// the file on disk, and its vectors in Milvus (via the RAG service).
func deleteDocument(c *gin.Context) {
	docID := c.Param("docId")
	ctx := context.Background()

	var filePath string
	if err := db.QueryRow(ctx, `SELECT file_path FROM uploaded_documents WHERE id=$1`, docID).Scan(&filePath); err != nil {
		c.JSON(404, gin.H{"error": "document not found"})
		return
	}
	if _, err := db.Exec(ctx, `DELETE FROM uploaded_documents WHERE id=$1`, docID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if filePath != "" {
		_ = os.Remove(filePath)
	}

	go ragDelete("/document/" + docID)
	c.JSON(200, gin.H{"ok": true})
}

// updateSubject toggles a subject's status (active/archived) or edits fields.
func updateSubject(c *gin.Context) {
	var req struct {
		Status      *string `json:"status"`
		Name        *string `json:"name"`
		Department  *string `json:"department"`
		Description *string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Status != nil && *req.Status != "active" && *req.Status != "archived" {
		c.JSON(400, gin.H{"error": "status must be 'active' or 'archived'"})
		return
	}
	_, err := db.Exec(context.Background(),
		`UPDATE subjects SET
		   status      = COALESCE($2, status),
		   name        = COALESCE($3, name),
		   department  = COALESCE($4, department),
		   description = COALESCE($5, description)
		 WHERE id=$1`,
		c.Param("id"), req.Status, req.Name, req.Department, req.Description)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// deleteSubject removes a subject and everything under it (enrollments,
// documents, chunks, generated questions, exams) plus its Milvus vectors.
func deleteSubject(c *gin.Context) {
	subjectID := c.Param("id")
	if _, err := db.Exec(context.Background(), `DELETE FROM subjects WHERE id=$1`, subjectID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	go ragDelete("/subject/" + subjectID)
	c.JSON(200, gin.H{"ok": true})
}

// ragDelete issues a best-effort DELETE to the RAG service.
func ragDelete(path string) {
	req, _ := http.NewRequest(http.MethodDelete, ragURL+path, nil)
	client := http.Client{Timeout: 30 * time.Second}
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
	}
}

// generateQuestions forwards the request to the RAG service, which retrieves
// grounded context and writes new rows to generated_questions for teacher review.
func generateQuestions(c *gin.Context) {
	subjectID := c.Param("id")
	var req struct {
		Topic        string         `json:"topic"`
		Topics       []string       `json:"topics"`
		TopicCounts  map[string]int `json:"topic_counts"`
		DocumentID   string         `json:"document_id"`
		DocumentIDs  []string       `json:"document_ids"`
		Distribution []struct {
			Type       string `json:"type"`
			Difficulty string `json:"difficulty"`
			Count      int    `json:"count"`
			Points     int    `json:"points"`
		} `json:"distribution"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	body, _ := json.Marshal(gin.H{
		"subject_id":   subjectID,
		"topic":        req.Topic,
		"topics":       req.Topics,
		"topic_counts": req.TopicCounts,
		"document_id":  req.DocumentID,
		"document_ids": req.DocumentIDs,
		"distribution": req.Distribution,
	})
	client := http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Post(ragURL+"/generate", "application/json", bytes.NewReader(body))
	if err != nil {
		c.JSON(502, gin.H{"error": "RAG service unavailable: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		c.JSON(502, gin.H{"error": "RAG service error"})
		return
	}
	var ragOut map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&ragOut)
	c.JSON(200, ragOut)
}

// getGenerationStatus reports progress of an async generation job.
func getGenerationStatus(c *gin.Context) {
	var status string
	var requested, generated int
	var errMsg *string
	err := db.QueryRow(context.Background(),
		`SELECT status, requested, generated, error FROM generation_jobs WHERE id=$1`,
		c.Param("jobId")).Scan(&status, &requested, &generated, &errMsg)
	if err != nil {
		c.JSON(404, gin.H{"error": "job not found"})
		return
	}
	c.JSON(200, gin.H{"status": status, "requested": requested, "generated": generated, "error": errMsg})
}
