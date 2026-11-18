# Code Assistants - Servidor de Autenticação

Servidor para login, cadastro e sincronização de chaves de IA entre dispositivos (APK e EXE).

## Opções de Hospedagem Gratuita

### Opção 1: Render (Recomendado)
1. Acesse [render.com](https://render.com) e crie uma conta gratuita
2. Clique em "New +" → "Web Service"
3. Conecte seu repositório GitHub ou faça upload manual
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Runtime:** Node
5. Adicione as variáveis de ambiente no painel:
   - `JWT_SECRET`: (gere uma string aleatória)
   - `ADMIN_EMAIL`: `admin@codeassistants.local`
   - `ADMIN_PASSWORD`: `sua-senha-segura`
   - `CORS_ORIGIN`: `https://seu-dominio-frontend.com` (ou `*` para desenvolvimento)

### Opção 2: Koyeb
1. Acesse [koyeb.com](https://koyeb.com)
2. Crie um "Service" → "GitHub" ou upload direto
3. Configure:
   - **Build Command:** `npm install && npm run build`
   - **Run Command:** `node server.js`
   - **Instance Type:** Nano (gratuito)

### Opção 3: Railway
1. Acesse [railway.app](https://railway.app)
2. Crie um "New Project" → "Deploy from GitHub repo"
3. Selecione este repositório/pasta `auth-server`
4. Adicione as variáveis de ambiente no painel

### Opção 4: Fly.io
1. Instale o flyctl: `curl -L https://fly.io/install.sh | sh`
2. `fly launch` na pasta `auth-server`
3. `fly deploy`
4. `fly secrets set JWT_SECRET=sua-chave ADMIN_EMAIL=... ADMIN_PASSWORD=...`

## Variáveis de Ambiente

| Variável | Obrigatório | Descrição | Exemplo |
|----------|-------------|-----------|---------|
| `PORT` | Não | Porta do servidor | `3001` |
| `JWT_SECRET` | Sim | Chave secreta para assinar tokens JWT | `sua-chave-secreta-aleatória` |
| `ADMIN_EMAIL` | Não | Email do administrador padrão | `admin@codeassistants.local` |
| `ADMIN_PASSWORD` | Não | Senha do administrador padrão | `sua-senha-segura` |
| `CORS_ORIGIN` | Não | URL do frontend permitido | `https://seu-app.vercel.app` |

## Testar Localmente

```bash
cd auth-server
npm install
npm start
# Servidor rodando em http://localhost:3001
```

## Testar a API

```bash
# Health check
curl https://seu-servidor.onrender.com/api/auth/health

# Cadastro
curl -X POST https://seu-servidor.onrender.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"usuario@email.com","password":"minhasenha123"}'

# Login
curl -X POST https://seu-servidor.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"usuario@email.com","password":"minhasenha123"}'

# Listar chaves (precisa do token)
curl -H "Authorization: Bearer SEU_TOKEN" \
  https://seu-servidor.onrender.com/api/auth/keys
```

## Conectar ao Aplicativo

Após publicar o servidor, defina a variável `VITE_AUTH_SERVER` no frontend:

```bash
# No frontend (code-assistants)
VITE_AUTH_SERVER=https://seu-servidor.onrender.com
```

Depois recompile o APK e o EXE com a nova variável de ambiente.

## Segurança

- ⚠️ **Nunca compartilhe sua JWT_SECRET**
- ⚠️ **Mude a senha do admin após o primeiro login**
- ✅ Use HTTPS em produção (o Render fornece automaticamente)
- ✅ O banco de dados SQLite é salvo em `auth.db` - faça backup regularmente
