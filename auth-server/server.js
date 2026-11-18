const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'code-assistants-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@codeassistants.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CodeAssistantsAdmin2026!';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

// Configuração de email (para verificação)
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';

const transporter = EMAIL_USER && EMAIL_PASS
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    })
  : null;

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Passport config
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: `${SERVER_URL}/api/auth/google/callback`
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    if (!email) return done(null, false);
    
    let user = await getUserByEmail(email);
    if (!user) {
      user = await createUser(email, null, 'google');
    }
    done(null, user);
  } catch (err) {
    done(err, null);
  }
}));

passport.use(new GitHubStrategy({
  clientID: process.env.GITHUB_CLIENT_ID || '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  callbackURL: `${SERVER_URL}/api/auth/github/callback`
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    if (!email) return done(null, false);
    
    let user = await getUserByEmail(email);
    if (!user) {
      user = await createUser(email, null, 'github');
    }
    done(null, user);
  } catch (err) {
    done(err, null);
  }
}));

app.use(passport.initialize());

// Banco de dados SQLite
const db = new sqlite3.Database('./auth.db');

// Criar tabelas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    provider TEXT DEFAULT 'email',
    provider_id TEXT,
    email_verified INTEGER DEFAULT 0,
    email_verification_token TEXT,
    is_admin INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
});

// Funções auxiliares
function getUserByEmail(email) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function getUserById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function createUser(email, password, provider = 'email') {
  return new Promise((resolve, reject) => {
    const id = uuidv4();
    const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
    const isAdmin = email === ADMIN_EMAIL ? 1 : 0;
    
    // Primeiro usuário cadastrado vira admin se não existir admin ainda
    db.get('SELECT id FROM users WHERE is_admin = 1 LIMIT 1', (err, adminRow) => {
      if (!adminRow && email !== ADMIN_EMAIL) {
        // Se não existe admin ainda, este primeiro usuário se torna admin
      }
    });
    
    db.run(
      'INSERT INTO users (id, email, password_hash, provider, provider_id, is_admin) VALUES (?, ?, ?, ?, ?, ?)',
      [id, email, passwordHash, provider, provider_id || null, isAdmin],
      function(err) {
        if (err) reject(err);
        else resolve({ id, email, provider, is_admin: isAdmin });
      }
    );
  });
}

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

// Middleware para verificar se é admin
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Cadastro com email e senha
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email já cadastrado' });
    }

    // Verificar se é o primeiro usuário -> vira admin
    const firstUser = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users LIMIT 1', (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    const isAdmin = firstUser ? 0 : 1; // Primeiro usuário vira admin

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO users (id, email, password_hash, is_admin, email_verification_token) VALUES (?, ?, ?, ?, ?)',
        [id, email, passwordHash, isAdmin, verificationToken],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      });
    });

    // Enviar email de verificação se houver SMTP configurado
    if (transporter) {
      const verifyUrl = `${SERVER_URL}/api/auth/verify-email?token=${verificationToken}`;
      await transporter.sendMail({
        from: EMAIL_USER,
        to: email,
        subject: 'Confirme seu email - Code Assistants',
        html: `<h2>Bem-vindo ao Code Assistants</h2><p>Clique no link abaixo para confirmar seu email:</p><a href="${verifyUrl}">Confirmar Email</a><p>Se não foi você, ignore este email.</p>`
      }).catch(() => {}); // Não falhar se email não enviar
    }

    const token = jwt.sign({ userId: id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ 
      ok: true, 
      token, 
      user: { id, email, is_admin: isAdmin === 1 },
      emailVerified: false
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Login com email e senha
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ error: 'Esta conta foi criada via login social. Use Google ou GitHub para entrar.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Email não verificado. Verifique sua caixa de entrada.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Conta desativada. Entre em contato com o suporte.' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, user: { id: user.id, email: user.email, is_admin: user.is_admin === 1 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Login com Google
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/api/auth/google/callback', passport.authenticate('google', { session: false }), (req, res) => {
  const user = req.user;
  const token = jwt.sign({ userId: user.id, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.redirect(`${FRONTEND_URL}/auth/callback?token=${token}&email=${encodeURIComponent(user.email)}&is_admin=${user.is_admin}`);
});

// Login com GitHub
app.get('/api/auth/github', passport.authenticate('github', { scope: ['user:email'] }));

app.get('/api/auth/github/callback', passport.authenticate('github', { session: false }), (req, res) => {
  const user = req.user;
  const token = jwt.sign({ userId: user.id, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.redirect(`${FRONTEND_URL}/auth/callback?token=${token}&email=${encodeURIComponent(user.email)}&is_admin=${user.is_admin}`);
});

// Verificar email
app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token não fornecido' });

    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE email_verification_token = ?', [token], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.status(400).json({ error: 'Token inválido ou expirado' });
    }

    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET email_verified = 1, email_verification_token = NULL WHERE id = ?', [user.id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ ok: true, message: 'Email verificado com sucesso!' });
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

// ==================== ROTAS DE ADMINISTRADOR ====================

// Listar todos os usuários (apenas admin)
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await new Promise((resolve, reject) => {
      db.all('SELECT id, email, provider, is_admin, is_active, email_verified, created_at FROM users ORDER BY created_at DESC', (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    res.json({ ok: true, users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Ativar/desativar usuário (apenas admin)
app.post('/api/admin/users/:id/toggle', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ ok: true, message: `Usuário ${is_active ? 'ativado' : 'desativado'} com sucesso` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Alterar papel de usuário (apenas admin)
app.post('/api/admin/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_admin } = req.body;
    
    // Não permitir desativar o último admin
    if (!is_admin) {
      const adminCount = await new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1', (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        });
      });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Não é possível desativar o último administrador' });
      }
    }
    
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET is_admin = ? WHERE id = ?', [is_admin ? 1 : 0, id], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ ok: true, message: `Usuário ${is_admin ? 'promovido a administrador' : 'rebaixado para usuário comum'}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Deletar usuário (apenas admin)
app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Não permitir deletar o último admin
    const user = await getUserById(id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.is_admin === 1) {
      const adminCount = await new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1', (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        });
      });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Não é possível deletar o último administrador' });
      }
    }
    
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM user_keys WHERE user_id = ?', [id], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ ok: true, message: 'Usuário deletado com sucesso' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Inicializar banco e criar administrador se não existir
db.serialize(() => {
  db.get('SELECT id FROM users WHERE is_admin = 1 LIMIT 1', (err, adminRow) => {
    if (err) {
      console.error(err);
      return;
    }
    if (!adminRow) {
      const id = uuidv4();
      const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      db.run(
        'INSERT INTO users (id, email, password_hash, is_admin, email_verified) VALUES (?, ?, ?, 1, 1)',
        [id, ADMIN_EMAIL, passwordHash],
        function(err) {
          if (err) console.error(err);
          else console.log(`Administrador criado: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
        }
      );
    }
  });
});

app.listen(PORT, () => {
  console.log(`Servidor de autenticação rodando na porta ${PORT}`);
  console.log(`Administrador: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
});

module.exports = app;
