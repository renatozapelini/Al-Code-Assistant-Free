const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'code-assistants-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@codeassistants.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CodeAssistantsAdmin2026!';

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Health check endpoint
app.get('/api/auth/health', (_req, res) => {
  res.json({ ok: true, service: 'code-assistants-auth', timestamp: new Date().toISOString() });
});

// Rota raiz para diagnóstico
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'Code Assistants Auth', version: '1.0.0', status: 'online' });
});

// Banco de dados SQLite
const db = new sqlite3.Database('./auth.db');

// Criar tabelas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_user_keys_user ON user_keys(user_id, provider)`);
});

// Middleware de autenticação JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Cadastro
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
    }

    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (existing) {
      return res.status(409).json({ error: 'Email já cadastrado' });
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    await new Promise((resolve, reject) => {
      db.run('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [id, email, passwordHash], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });

    const token = jwt.sign({ userId: id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, user: { id, email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar chaves do usuário
app.get('/api/auth/keys', authenticateToken, async (req, res) => {
  try {
    const keys = await new Promise((resolve, reject) => {
      db.all('SELECT id, provider, api_key FROM user_keys WHERE user_id = ?', [req.user.userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    res.json({ ok: true, keys });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Salvar/atualizar chave
app.post('/api/auth/keys', authenticateToken, async (req, res) => {
  try {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey) {
      return res.status(400).json({ error: 'Provedor e chave são obrigatórios' });
    }

    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM user_keys WHERE user_id = ? AND provider = ?', [req.user.userId, provider], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (existing) {
      await new Promise((resolve, reject) => {
        db.run('UPDATE user_keys SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [apiKey, existing.id], function(err) {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      await new Promise((resolve, reject) => {
        db.run('INSERT INTO user_keys (id, user_id, provider, api_key) VALUES (?, ?, ?, ?)', [uuidv4(), req.user.userId, provider, apiKey], function(err) {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Remover chave
app.delete('/api/auth/keys/:id', authenticateToken, async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM user_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Inicializar banco e criar administrador se não existir
db.serialize(() => {
  db.get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL], async (err, row) => {
    if (err) {
      console.error(err);
      return;
    }
    if (!row) {
      const id = uuidv4();
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await new Promise((resolve, reject) => {
        db.run('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [id, ADMIN_EMAIL, passwordHash], function(err) {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log(`Administrador criado: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    }
  });
});

app.listen(PORT, () => {
  console.log(`Servidor de autenticação rodando na porta ${PORT}`);
  console.log(`Administrador: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
});

module.exports = app;
