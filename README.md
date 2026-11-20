# What Exam

What Exam creates, delivers and marks exams through WhatsApp. The workspace has no seeded exams or sample student records. Exams, invitations, answer transcripts and marks are stored in PostgreSQL.

## What it does

- Create an exam from a teaching brief with OpenAI structured output.
- Upload a PDF and ask an AI model to extract objective and theory questions across its pages. Questions with uncertain answer keys are marked for teacher review and cannot be published until confirmed.
- Write questions manually, including objective answer keys and theory rubrics.
- Invite students through an approved WhatsApp Business message template after recording their opt-in.
- Deliver one question at a time through the WhatsApp Cloud API. Students can answer objective questions with an option letter, and theory questions with text, a photo, or a voice note.
- Transcribe WhatsApp voice notes, mark theory and photo responses with OpenAI, calculate scores, and review every answer from the teacher workspace.
- Store webhook events in PostgreSQL before acknowledging Meta. A small database-backed worker processes inbound replies and retries temporary failures.

## Local development

Requirements: Node.js 20+ and PostgreSQL.

1. Create a PostgreSQL database and copy `.env.example` to `.env`.
2. Fill `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `OPENAI_API_KEY`.
3. Install dependencies with `npm install`.
4. Start the app with `npm start`, then open `http://localhost:3000`.

WhatsApp delivery requires a public HTTPS callback, so configure it after deploying the app.

## Render deployment

`render.yaml` creates a Node web service and a managed PostgreSQL database. Connect this repository to Render through a Git provider, create a Blueprint from the repository, and enter the prompted secrets in the Render Dashboard. Do not commit secret values.

The Blueprint prompts for:

- `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the private teacher workspace.
- `OPENAI_API_KEY` for question creation, PDF extraction, AI marking and voice transcription.
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_TEMPLATE_NAME` for WhatsApp Cloud API delivery and webhook verification.

The Blueprint generates `SESSION_SECRET`. The selected AI model, transcription model, WhatsApp Graph version, and template language have defaults and can be changed in Render.

### Meta WhatsApp setup

1. Configure a WhatsApp Business Cloud API phone number and a permanent/system-user access token with the required messaging permissions.
2. Create and get approval for a utility template with two body parameters. Suggested body: `You are invited to take {{1}} with What Exam. Reply START {{2}} to begin. Your answers will be recorded for your teacher.` Set the same template name and language in Render.
3. In the Meta app, configure the callback URL as `https://<your-render-service>.onrender.com/webhooks/whatsapp`, enter the same `WHATSAPP_VERIFY_TOKEN`, and subscribe to the `messages` webhook field.
4. Set `WHATSAPP_APP_SECRET` to the Meta app secret. The app verifies `X-Hub-Signature-256` before queuing a webhook event.
5. Students must have opted in to messages from the business. The invite form requires the teacher to confirm that consent before sending.

The exam runs inside WhatsApp: the student replies `START` plus their invitation code, then sends each answer in chat. A student must finish their active exam before they can start another one.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Render Postgres connection string |
| `SESSION_SECRET` | Signs the HTTP-only admin session cookie |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Single workspace admin sign-in |
| `OPENAI_API_KEY` | Server-only OpenAI credential |
| `OPENAI_MODEL` | Responses API model for generation and marking; defaults to `gpt-6.2-astra` |
| `OPENAI_TRANSCRIBE_MODEL` | Audio transcription model; defaults to `gpt-transcribe` |
| `WHATSAPP_ACCESS_TOKEN` | Meta system-user access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Cloud API sender number ID |
| `WHATSAPP_VERIFY_TOKEN` | Webhook subscription verification token |
| `WHATSAPP_APP_SECRET` | Verifies Meta webhook signatures |
| `WHATSAPP_TEMPLATE_NAME` | Approved invite template name |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Template locale; defaults to `en_US` |
| `WHATSAPP_GRAPH_VERSION` | Graph API version; defaults to `v27.0` |

The application never returns or displays API key values. It displays only whether the required services appear configured.

## Operational notes

- The teacher workspace uses one administrator account configured in Render.
- Uploaded PDFs are held in memory for processing and are not saved to the web service filesystem. The upload limit is 20 MB.
- WhatsApp media is fetched from Meta and used for transcription or marking. The app stores the Meta media ID and derived transcript/mark, not a local copy of the file.
- Objective grading compares the selected option against the saved key. Theory and photo grading use the configured OpenAI model and rubric.
- AI marks are reviewable by the teacher in the Results screen. Teachers should review generated questions and uncertain PDF answer keys before publishing.
- The requested Render setup uses the free web and Postgres plans. Free web services sleep after 15 minutes without traffic, so the first visit may take about a minute to wake them. Free Postgres expires after 30 days and has no backups. Upgrade the database before relying on it for long-term exam records or real student assessments.
