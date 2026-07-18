-- Seed data. All seeded accounts use password: password123
-- (bcrypt hash generated via pgcrypto bf, verifiable by Go's bcrypt)

INSERT INTO users (id, email, password_hash, full_name, role, identifier, status) VALUES
  ('11111111-1111-1111-1111-111111111111', 'admin@university.edu',   crypt('password123', gen_salt('bf')), 'Admin User',        'admin',    'EMP-000001', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'grecia@university.edu',  crypt('password123', gen_salt('bf')), 'Prof. Grecia',      'educator', 'EMP-987654', 'active'),
  ('33333333-3333-3333-3333-333333333333', 'alex@university.edu',    crypt('password123', gen_salt('bf')), 'Alex Rivera',       'student',  'S-12345678', 'active');

INSERT INTO subjects (id, code, name, department, description, educator_id, status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'CS101', 'Introduction to AI', 'School of Engineering', 'Foundations of artificial intelligence.', '22222222-2222-2222-2222-222222222222', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'ML204', 'Machine Learning',   'School of Engineering', 'Supervised and unsupervised learning.',  '22222222-2222-2222-2222-222222222222', 'active');

INSERT INTO subject_enrollments (subject_id, student_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333');

INSERT INTO uploaded_documents (id, subject_id, uploaded_by, filename, file_type, module_label, file_path, size_bytes, status) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222',
   'intro_to_ai.txt', 'TXT', 'Module 1', '/app/uploads/seed/intro_to_ai.txt', 2048, 'ready');

INSERT INTO document_chunks (document_id, subject_id, chunk_index, content) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 0,
   'Backpropagation computes the gradient of the loss function with respect to each weight using the chain rule, propagating errors backward from the output layer. Unsupervised learning finds hidden patterns in unlabeled data. The ReLU activation function does not saturate for positive inputs, mitigating the vanishing gradient problem compared to Sigmoid. Vector databases such as Milvus store high-dimensional embeddings for fast similarity search in Retrieval-Augmented Generation (RAG).');

-- A published exam with approved questions
INSERT INTO exams (id, subject_id, title, duration_min, total_points, access_code, status, created_by) VALUES
  ('cccccccc-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'Introduction to AI - Midterm', 60, 15, '482913', 'published',
   '22222222-2222-2222-2222-222222222222');

INSERT INTO exam_questions (exam_id, type, difficulty, points, prompt, options, answer, topic, source_ref, position) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'mcq', 'medium', 5,
   'Which of the following describes "Unsupervised Learning"?',
   '["Learning from unlabeled data to find hidden patterns.","Learning from labeled examples.","Learning by maximizing a reward signal.","Memorizing the training set."]'::jsonb,
   '{"correct_index":0}'::jsonb,
   'Machine Learning', 'intro_to_ai.txt: "Unsupervised learning finds hidden patterns in unlabeled data."', 1),
  ('cccccccc-0000-0000-0000-000000000001', 'true_false', 'easy', 5,
   'The ReLU activation function is more prone to the vanishing gradient problem than Sigmoid.',
   '["True","False"]'::jsonb,
   '{"correct":false}'::jsonb,
   'Neural Networks', 'intro_to_ai.txt: "ReLU does not saturate for positive inputs..."', 2),
  ('cccccccc-0000-0000-0000-000000000001', 'fill_blank', 'hard', 5,
   'In neural networks, the _____ function determines the output of a node given its inputs.',
   NULL,
   '{"accepted":["activation"]}'::jsonb,
   'Neural Networks', 'intro_to_ai.txt', 3);

-- A couple of pending AI-generated questions awaiting educator review
INSERT INTO generated_questions (subject_id, document_id, type, difficulty, points, prompt, options, answer, topic, source_ref, status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'mcq', 'medium', 5,
   'What is the primary purpose of the backpropagation algorithm?',
   '["To compute gradients of the loss for weight updates.","To initialize random weights.","To store embeddings.","To visualize the network."]'::jsonb,
   '{"correct_index":0}'::jsonb,
   'Neural Networks', 'intro_to_ai.txt: "Backpropagation computes the gradient of the loss..."', 'pending'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'true_false', 'easy', 3,
   'Milvus is a vector database used for similarity search in RAG systems.',
   '["True","False"]'::jsonb,
   '{"correct":true}'::jsonb,
   'RAG', 'intro_to_ai.txt: "Vector databases such as Milvus store high-dimensional embeddings..."', 'pending');
