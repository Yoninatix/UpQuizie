package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const cookieName = "upquiz_token"
const tokenTTL = 24 * time.Hour

type registerReq struct {
	Email      string `json:"email" binding:"required,email"`
	Password   string `json:"password" binding:"required,min=6"`
	FullName   string `json:"full_name" binding:"required"`
	Role       string `json:"role"`
	Identifier string `json:"identifier"`
}

type loginReq struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

func issueToken(userID, role string) (string, error) {
	claims := jwt.MapClaims{
		"sub":  userID,
		"role": role,
		"exp":  time.Now().Add(tokenTTL).Unix(),
		"iat":  time.Now().Unix(),
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString(jwtSecret)
}

// setAuthCookie issues an HTTP-only cookie holding the JWT.
func setAuthCookie(c *gin.Context, token string) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(cookieName, token, int(tokenTTL.Seconds()), "/", "", false, true)
}

func handleRegister(c *gin.Context) {
	var req registerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	role := req.Role
	if role != "student" && role != "educator" && role != "admin" {
		role = "student"
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "hash failed"})
		return
	}
	var id string
	err = db.QueryRow(context.Background(),
		`INSERT INTO users (email, password_hash, full_name, role, identifier)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		strings.ToLower(req.Email), string(hash), req.FullName, role, req.Identifier).Scan(&id)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "email already registered"})
		return
	}
	token, _ := issueToken(id, role)
	setAuthCookie(c, token)
	c.JSON(http.StatusCreated, gin.H{
		"user": gin.H{"id": id, "email": req.Email, "full_name": req.FullName, "role": role},
	})
}

// createUserAdmin provisions an account on behalf of an admin. Unlike
// handleRegister it must not touch the session cookie, or the admin would be
// logged in as the user they just created.
func createUserAdmin(c *gin.Context) {
	var req struct {
		Email      string `json:"email" binding:"required,email"`
		Password   string `json:"password" binding:"required,min=6"`
		FullName   string `json:"full_name" binding:"required"`
		Role       string `json:"role"`
		Identifier string `json:"identifier"`
		Status     string `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	role := req.Role
	if role != "student" && role != "educator" && role != "admin" {
		role = "student"
	}
	status := req.Status
	if status != "active" && status != "inactive" && status != "pending" {
		status = "active"
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "hash failed"})
		return
	}
	var id string
	var created time.Time
	err = db.QueryRow(context.Background(),
		`INSERT INTO users (email, password_hash, full_name, role, identifier, status)
		 VALUES ($1,$2,$3,$4,NULLIF($5,''),$6) RETURNING id, created_at`,
		strings.ToLower(req.Email), string(hash), req.FullName, role, req.Identifier, status).Scan(&id, &created)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "email already registered"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id, "email": strings.ToLower(req.Email),
		"full_name": req.FullName, "role": role, "identifier": req.Identifier,
		"status": status, "created_at": created})
}

func handleLogin(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var id, hash, fullName, role, status string
	err := db.QueryRow(context.Background(),
		`SELECT id, password_hash, full_name, role, status FROM users WHERE email=$1`,
		strings.ToLower(req.Email)).Scan(&id, &hash, &fullName, &role, &status)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	if status == "inactive" {
		c.JSON(http.StatusForbidden, gin.H{"error": "account is deactivated"})
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	token, _ := issueToken(id, role)
	setAuthCookie(c, token)
	c.JSON(http.StatusOK, gin.H{
		"user": gin.H{"id": id, "email": req.Email, "full_name": fullName, "role": role},
	})
}

func handleLogout(c *gin.Context) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(cookieName, "", -1, "/", "", false, true)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// authMiddleware reads the JWT from the HTTP-only cookie (falling back to the
// Authorization header for API clients/tests).
func authMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		tokenStr := ""
		if ck, err := c.Cookie(cookieName); err == nil {
			tokenStr = ck
		} else if h := c.GetHeader("Authorization"); strings.HasPrefix(h, "Bearer ") {
			tokenStr = strings.TrimPrefix(h, "Bearer ")
		}
		if tokenStr == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
			return
		}
		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			return jwtSecret, nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		claims := token.Claims.(jwt.MapClaims)
		userID, _ := claims["sub"].(string)
		role, _ := claims["role"].(string)
		if userID == "" || role == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token claims"})
			return
		}
		c.Set("userID", userID)
		c.Set("role", role)
		c.Next()
	}
}

func requireRole(roles ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		role, _ := c.Get("role")
		for _, r := range roles {
			if role == r {
				c.Next()
				return
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
	}
}

// requireSubjectAccess prevents one account from reaching another teacher's
// subject by manually changing the subject ID in the URL. Administrators can
// access every subject, educators only subjects they own, and students only
// subjects in which they are enrolled.
func requireSubjectAccess() gin.HandlerFunc {
	return func(c *gin.Context) {
		role, _ := c.Get("role")
		userID, _ := c.Get("userID")
		if role == "admin" {
			c.Next()
			return
		}

		var allowed bool
		var err error
		switch role {
		case "educator":
			err = db.QueryRow(context.Background(),
				`SELECT EXISTS(SELECT 1 FROM subjects WHERE id=$1 AND educator_id=$2)`,
				c.Param("id"), userID).Scan(&allowed)
		case "student":
			err = db.QueryRow(context.Background(),
				`SELECT EXISTS(SELECT 1 FROM subject_enrollments WHERE subject_id=$1 AND student_id=$2)`,
				c.Param("id"), userID).Scan(&allowed)
		default:
			allowed = false
		}
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "could not verify subject access"})
			return
		}
		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "this subject belongs to another teacher"})
			return
		}
		c.Next()
	}
}

func requireSubjectOwner() gin.HandlerFunc {
	return func(c *gin.Context) {
		role, _ := c.Get("role")
		if role != "educator" && role != "admin" {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
			return
		}
		requireSubjectAccess()(c)
	}
}

func handleMe(c *gin.Context) {
	userID, _ := c.Get("userID")
	user, err := loadUser(userID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, user)
}

func loadUser(userID any) (gin.H, error) {
	var email, fullName, role string
	var identifier, avatarURL *string
	err := db.QueryRow(context.Background(),
		`SELECT email, full_name, role, identifier, avatar_url FROM users WHERE id=$1`, userID).
		Scan(&email, &fullName, &role, &identifier, &avatarURL)
	if err != nil {
		return nil, err
	}
	return gin.H{
		"id": userID, "email": email, "full_name": fullName, "role": role,
		"identifier": identifier, "avatar_url": avatarURL,
	}, nil
}

// updateMe lets a user edit their own name, email, and ID number (never role
// or status).
func updateMe(c *gin.Context) {
	userID, _ := c.Get("userID")
	var req struct {
		FullName   *string `json:"full_name"`
		Email      *string `json:"email"`
		Identifier *string `json:"identifier"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.FullName != nil && strings.TrimSpace(*req.FullName) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "full_name cannot be empty"})
		return
	}
	if req.Email != nil {
		trimmed := strings.ToLower(strings.TrimSpace(*req.Email))
		if trimmed == "" || !strings.Contains(trimmed, "@") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "a valid email is required"})
			return
		}
		req.Email = &trimmed
	}
	_, err := db.Exec(context.Background(),
		`UPDATE users SET full_name=COALESCE($2,full_name), email=COALESCE($3,email),
		 identifier=NULLIF(COALESCE($4,identifier),'') WHERE id=$1`,
		userID, req.FullName, req.Email, req.Identifier)
	if err != nil {
		if strings.Contains(err.Error(), "users_email_key") {
			c.JSON(http.StatusConflict, gin.H{"error": "That email is already in use by another account."})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	user, err := loadUser(userID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, user)
}

// changePassword verifies the current password before setting a new one.
func changePassword(c *gin.Context) {
	userID, _ := c.Get("userID")
	var req struct {
		CurrentPassword string `json:"current_password" binding:"required"`
		NewPassword     string `json:"new_password" binding:"required,min=6"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "New password must be at least 6 characters."})
		return
	}
	var hash string
	if err := db.QueryRow(context.Background(),
		`SELECT password_hash FROM users WHERE id=$1`, userID).Scan(&hash); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.CurrentPassword)) != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Current password is incorrect."})
		return
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "hash failed"})
		return
	}
	if _, err := db.Exec(context.Background(),
		`UPDATE users SET password_hash=$2 WHERE id=$1`, userID, string(newHash)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// uploadAvatar stores a profile picture in the uploads volume and points
// users.avatar_url at it. A timestamped filename keeps browser caches fresh;
// older avatars for the same user are cleaned up after the new one is saved.
func uploadAvatar(c *gin.Context) {
	userID, _ := c.Get("userID")
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required (multipart field 'file')"})
		return
	}
	if fileHeader.Size > 5<<20 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "image must be 5 MB or smaller"})
		return
	}
	ext := strings.ToLower(filepath.Ext(fileHeader.Filename))
	allowed := map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true}
	if !allowed[ext] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "image must be jpg, png, webp, or gif"})
		return
	}
	dir := filepath.Join(uploadDir, "avatars")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	old, _ := filepath.Glob(filepath.Join(dir, fmt.Sprintf("%v-*", userID)))
	name := fmt.Sprintf("%v-%d%s", userID, time.Now().UnixNano(), ext)
	if err := c.SaveUploadedFile(fileHeader, filepath.Join(dir, name)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save file: " + err.Error()})
		return
	}
	url := "/api/avatars/" + name
	if _, err := db.Exec(context.Background(),
		`UPDATE users SET avatar_url=$2 WHERE id=$1`, userID, url); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	for _, f := range old {
		os.Remove(f)
	}
	c.JSON(http.StatusOK, gin.H{"avatar_url": url})
}

// serveAvatar returns a stored profile picture. filepath.Base guards against
// path traversal in the name parameter.
func serveAvatar(c *gin.Context) {
	name := filepath.Base(c.Param("name"))
	path := filepath.Join(uploadDir, "avatars", name)
	if _, err := os.Stat(path); err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	c.File(path)
}
