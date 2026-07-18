package main

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	db        *pgxpool.Pool
	jwtSecret []byte
	ragURL    string
	uploadDir string
)

func main() {
	jwtSecret = []byte(getenv("JWT_SECRET", "change-me-in-production"))
	ragURL = getenv("RAG_SERVICE_URL", "http://rag:7000")
	uploadDir = getenv("UPLOAD_DIR", "/app/uploads")
	dbURL := getenv("DATABASE_URL", "postgres://upquizie:upquizie@postgres:5432/examdb?sslmode=disable")

	_ = os.MkdirAll(uploadDir, 0o755)

	var err error
	for i := 0; i < 30; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		db, err = pgxpool.New(ctx, dbURL)
		if err == nil {
			err = db.Ping(ctx)
		}
		cancel()
		if err == nil {
			break
		}
		log.Printf("waiting for postgres... (%v)", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("could not connect to postgres: %v", err)
	}
	log.Println("connected to postgres (examdb)")
	ensureSchema()

	r := gin.Default()
	r.MaxMultipartMemory = 32 << 20 // 32 MiB

	origins := strings.Split(getenv("CORS_ORIGINS", "http://localhost:8080,http://localhost:5173"), ",")
	r.Use(cors.New(cors.Config{
		AllowOrigins:     origins,
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		AllowCredentials: true,
	}))

	api := r.Group("/api")
	api.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "ok"}) })

	api.POST("/auth/register", handleRegister)
	api.POST("/auth/login", handleLogin)
	api.POST("/auth/logout", handleLogout)

	api.GET("/avatars/:name", serveAvatar)
	api.GET("/question-images/:name", serveQuestionImage)

	auth := api.Group("")
	auth.Use(authMiddleware())
	{
		auth.GET("/me", handleMe)
		auth.PATCH("/me", updateMe)
		auth.POST("/me/avatar", uploadAvatar)
		auth.POST("/me/password", changePassword)

		// Subjects & enrollment
		auth.GET("/subjects", listSubjects)
		auth.POST("/subjects", requireRole("educator", "admin"), createSubject)
		auth.PATCH("/subjects/:id", requireSubjectOwner(), updateSubject)
		auth.DELETE("/subjects/:id", requireSubjectOwner(), deleteSubject)
		auth.GET("/subjects/:id/students", requireSubjectOwner(), listStudents)
		auth.POST("/subjects/:id/enroll", requireSubjectOwner(), enrollStudent)
		auth.DELETE("/subjects/:id/students/:studentId", requireSubjectOwner(), dropStudent)

		// Learning materials (file upload -> RAG processing)
		auth.GET("/subjects/:id/documents", requireSubjectAccess(), listDocuments)
		auth.GET("/subjects/:id/generation-options", requireSubjectOwner(), generationOptions)
		auth.POST("/subjects/:id/documents", requireSubjectOwner(), uploadDocument)
		auth.DELETE("/subjects/:id/documents/:docId", requireSubjectOwner(), deleteDocument)

		// RAG question generation (async) + review/approval
		auth.POST("/subjects/:id/generate", requireSubjectOwner(), generateQuestions)
		auth.GET("/generation/:jobId", requireRole("educator", "admin"), getGenerationStatus)
		auth.GET("/subjects/:id/generated", requireSubjectOwner(), listGenerated)
		auth.GET("/subjects/:id/question-bank", requireSubjectOwner(), questionBank)
		auth.DELETE("/subjects/:id/generated", requireSubjectOwner(), deleteAllGenerated)
		auth.PATCH("/generated/:gid", requireRole("educator", "admin"), updateGenerated)
		auth.POST("/generated/:gid/image", requireRole("educator", "admin"), uploadGeneratedQuestionImage)
		auth.DELETE("/generated/:gid/image", requireRole("educator", "admin"), removeGeneratedQuestionImage)

		// Exams (built from approved questions)
		auth.GET("/exams", listExams)
		auth.POST("/exams", requireRole("educator", "admin"), createExam)
		auth.GET("/exams/:id", getExam)
		auth.PATCH("/exams/:id", requireRole("educator", "admin"), updateExam)
		auth.GET("/exams/:id/questions", listExamQuestions)
		auth.PATCH("/exam-questions/:qid", requireRole("educator", "admin"), updateExamQuestion)
		auth.POST("/exams/:id/publish", requireRole("educator", "admin"), publishExam)
		auth.POST("/exams/:id/activation", requireRole("educator", "admin"), setExamActivation)
		auth.DELETE("/exams/:id", requireRole("educator", "admin"), deleteExam)

		// Attempts & scoring
		auth.POST("/exams/:id/attempts", startAttempt)
		auth.POST("/attempts/:aid/submit", submitAttempt)
		auth.POST("/attempts/:aid/heartbeat", heartbeat)
		auth.GET("/attempts/:aid", getAttempt)
		auth.GET("/grading/submissions", requireRole("educator", "admin"), listGradingSubmissions)
		auth.GET("/attempts/:aid/review", requireRole("educator", "admin"), reviewAttempt)
		auth.PATCH("/attempts/:aid/answers/:answerId", requireRole("educator", "admin"), updateAnswerScore)

		// Live exam-session monitoring (educator)
		auth.GET("/exams/:id/monitor", requireRole("educator", "admin"), examMonitor)
		auth.POST("/exams/:id/start", requireRole("educator", "admin"), startLiveExam)

		// Student self-service
		auth.GET("/me/performance", studentPerformance)
		auth.GET("/exams/:id/access", examAccessInfo)
		auth.POST("/exams/:id/verify", verifyExamAccess)

		// Analytics
		auth.GET("/subjects/:id/analytics", requireSubjectOwner(), subjectAnalytics)

		// Admin
		auth.GET("/admin/users", requireRole("admin"), listUsers)
		auth.POST("/admin/users", requireRole("admin"), createUserAdmin)
		auth.PATCH("/admin/users/:uid", requireRole("admin"), updateUser)
		auth.DELETE("/admin/users/:uid", requireRole("admin"), deleteUser)
	}

	port := getenv("APP_PORT", "8000")
	log.Printf("API listening on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func ensureSchema() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	statements := []string{
		`ALTER TABLE uploaded_documents ADD COLUMN IF NOT EXISTS module_label TEXT NOT NULL DEFAULT 'Module 1'`,
		`CREATE INDEX IF NOT EXISTS idx_documents_module ON uploaded_documents(subject_id, module_label)`,
		`ALTER TABLE exams ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ`,
		`ALTER TABLE exams ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`,
		`ALTER TABLE generated_questions ADD COLUMN IF NOT EXISTS image_url TEXT`,
		`ALTER TABLE exam_questions ADD COLUMN IF NOT EXISTS image_url TEXT`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			log.Fatalf("could not apply schema update: %v", err)
		}
	}
}
