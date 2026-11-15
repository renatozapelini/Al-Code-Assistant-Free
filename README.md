# Code Assistants

Aplicativo Android para reunir várias APIs de inteligência artificial em um só lugar, conversar livremente e desenvolver projetos com uma equipe de assistentes que preserva arquivos, tarefas, plano e checkpoints.

Desenvolvido para Renato Zapelini com assistência do **Qoder**. O Qoder participou do desenvolvimento e aparece no aplicativo como assistente e acesso oficial; ele **não é apresentado como uma API de inferência** quando não existe uma integração oficial verificável para isso.

## Principais recursos

- Chat livre com conversas separadas por assunto.
- Escolha da IA antes de cada mensagem.
- APIs funcionando disponíveis para seleção; APIs pausadas, não testadas, com falha ou em cooldown continuam visíveis, porém desabilitadas.
- Etapas reais da resposta: preparação, provedor escolhido, recebimento, failover, latência e erro retornado.
- Projetos com chat próprio, arquivos, tarefas, equipe de IAs e checkpoints locais.
- Troca automática de provedor quando uma API selecionada falha ou fica temporariamente indisponível.
- Pré-prompt para detalhar ideias antes de iniciar um projeto.
- Cadastro de várias chaves, inclusive várias chaves do mesmo provedor.
- Teste real das APIs, com latência ou motivo da recusa.
- Exportação dos arquivos do projeto em ZIP.
- Verificação manual de nova versão pelos releases públicos deste repositório.

## Provedores e assistentes

O aplicativo inclui configurações para OpenAI, Google Gemini, Anthropic/Claude, OpenRouter, GitHub Models, Groq, DeepSeek, Mistral, xAI, Ollama, LM Studio e endpoints personalizados.

- **Google Gemini:** usa a API nativa `generateContent` e o cabeçalho `x-goog-api-key`; não é tratado como OpenAI-compatible.
- **Anthropic:** é a empresa responsável pelo Claude. O formato Anthropic Messages é mostrado somente onde faz sentido, especialmente Claude e endpoints personalizados.
- **Qoder:** login assistido pelo site oficial e registro local de múltiplos perfis. O app não captura senha, cookie, CAPTCHA, token ou sessão do navegador.
- Opções com cota grátis ficam ocultas por padrão e só aparecem quando o usuário decide mostrá-las. Nada é adicionado automaticamente.

## Privacidade e segurança

- Chaves e projetos ficam no dispositivo; não existe nuvem externa do projeto para armazenar chaves privadas.
- Chaves são mascaradas na leitura e não são publicadas no GitHub.
- O motor Android atende apenas a WebView local em `127.0.0.1:8790`, protegido por sessão e sem CORS público.
- O app não cria contas automaticamente, não resolve CAPTCHA e não resgata créditos.
- Login de provedores é feito no navegador/site oficial, com participação humana.
- Não depende de Termux nem de scripts externos no telefone.

## Instalação

Baixe o APK canônico na página de [Releases](https://github.com/renatozapelini/Al-Code-Assistant-Free/releases). O arquivo segue o formato:

```text
Code-Assistants-vX.Y.Z.apk
```

No Android, autorize a instalação pelo navegador ou gerenciador de arquivos utilizado. A atualização não é instalada silenciosamente: o aplicativo apenas verifica o release e abre o download confirmado para decisão do usuário.

## Desenvolvimento e validação

Requisitos para a interface: Bun e JDK 17. O build Android também exige Android SDK 34 e Build Tools 34.0.0 já instalados.

```bash
bun install
bun run lint
bun run build
bun src/server/androidUiCheck.ts
```

A validação controlada usa provedores locais fictícios, sem credenciais reais, e cobre o motor Java, troca de assistentes, preservação de checkpoint, segurança local e layouts móveis.

## Limites importantes

Provedores externos como OpenAI, Google, Anthropic e Qoder exigem verificação humana para criação e acesso às contas. O Code Assistants organiza acessos e chaves fornecidos pelo usuário, mas não automatiza registros fraudulentos nem contorna as regras dos provedores.
