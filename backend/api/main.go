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
		auth.PATCH("/subjects/:id", requireRole("educator", "admin"), updateSubject)
		auth.DELETE("/subjects/:id", requireRole("educator", "admin"), deleteSubject)
		auth.GET("/subjects/:id/students", requireRole("educator", "admin"), listStudents)
		auth.POST("/subjects/:id/enroll", requireRole("educator", "admin"), enrollStudent)

		// Learning materials (file upload -> RAG processing)
		auth.GET("/subjects/:id/documents", listDocuments)
		auth.GET("/subjects/:id/generation-options", requireRole("educator", "admin"), generationOptions)
		auth.POST("/subjects/:id/documents", requireRole("educator", "admin"), uploadDocument)
		auth.DELETE("/subjects/:id/documents/:docId", requireRole("educator", "admin"), deleteDocument)

		// RAG question generation (async) + review/approval
		auth.POST("/subjects/:id/generate", requireRole("educator", "admin"), generateQuestions)
		auth.GET("/generation/:jobId", requireRole("educator", "admin"), getGenerationStatus)
		auth.GET("/subjects/:id/generated", requireRole("educator", "admin"), listGenerated)
		auth.DELETE("/subjects/:id/generated", requireRole("educator", "admin"), deleteAllGenerated)
		auth.PATCH("/generated/:gid", requireRole("educator", "admin"), updateGenerated)

		// Exams (built from approved questions)
		auth.GET("/exams", listExams)
		auth.POST("/exams", requireRole("educator", "admin"), createExam)
		auth.GET("/exams/:id", getExam)
		auth.GET("/exams/:id/questions", listExamQuestions)
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
		auth.GET("/subjects/:id/analytics", requireRole("educator", "admin"), subjectAnalytics)

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
