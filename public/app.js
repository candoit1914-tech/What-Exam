const icons = {
  grid: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3.8h8l4.5 4.5v11.9H6z"/><path d="M14 3.8v4.7h4.5M9 13h6M9 16.5h6"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 19.5h16M6.5 16V10M12 16V5M17.5 16v-4"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z"/><path d="m19.4 13.8 1.1.9-1.4 2.4-1.3-.5a7.5 7.5 0 0 1-1.5.9l-.2 1.4h-2.8l-.3-1.4a7.5 7.5 0 0 1-1.5-.9l-1.3.5-1.4-2.4 1.1-.9a7.5 7.5 0 0 1 0-1.7l-1.1-.9 1.4-2.4 1.3.5a7.5 7.5 0 0 1 1.5-.9l.3-1.4h2.8l.2 1.4a7.5 7.5 0 0 1 1.5.9l1.3-.5 1.4 2.4-1.1.9a7.5 7.5 0 0 1 0 1.7Z" transform="translate(-.7 -1) scale(.99)"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="m21 3-7.5 18-3.8-7.7L2 9.5zM21 3 9.7 13.3"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 15V4m-4 4 4-4 4 4M4 15.5v4h16v-4"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l1 2.8 2.5 1-2.5.9-1 2.3-.9-2.3-2.6-.9 2.6-1z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M19 12H5m7 7-7-7 7-7"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 13h11l1-13M9 7V4h6v3"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.7"/></svg>',
  school: '<svg viewBox="0 0 24 24"><path d="m3 9 9-5 9 5-9 5zM6 11v6l6 3 6-3v-6M21 9v7"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M10 4H5v16h5M14 8l4 4-4 4m4-4H9"/></svg>',
};
const app = document.getElementById('app');
const state = { user: null, page: 'overview', exams: [], dashboard: null, results: [], detail: null, draft: null, draftId: null, createMethod: 'ai', search: '', busy: false, pendingFile: null };
let toastTimer;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initials = value => String(value || 'A').split('@')[0].split(/[ ._-]/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || 'A';
const newQuestion = (kind = 'objective') => ({ kind, text: '', options: kind === 'objective' ? ['', '', '', ''] : [], correctOption: 0, answer: '', points: 1, modes: kind === 'theory' ? ['text', 'photo', 'audio'] : [], rubric: '', reviewRequired: false });
const newDraft = () => ({ title: '', subject: '', level: '', instructions: '', durationMinutes: 30, passMark: 60, questions: [newQuestion()] });

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  if (response.status === 401 && url !== '/api/auth/me') {
    state.user = null;
    render();
    throw new Error(body?.error || 'Please sign in again.');
  }
  if (!response.ok) throw new Error(body?.error || 'Something went wrong. Please try again.');
  return body;
}

function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
}

function button(label, action, className = 'btn btn-primary', icon = '') {
  return `<button type="button" class="${className}" data-action="${action}">${icon ? icons[icon] || icon : ''}${escapeHtml(label)}</button>`;
}

function statusTag(status) {
  const value = status || 'draft';
  const label = value === 'live' ? 'Live' : value === 'paused' ? 'Paused' : 'Draft';
  return `<span class="status ${escapeHtml(value)}">${label}</span>`;
}

function renderLogin(errorText = '') {
  app.innerHTML = `<main class="login-wrap"><section class="login-brand-pane"><div class="brand"><div class="brand-mark"></div><div class="brand-name">What <span>Exam</span></div></div><div class="login-tagline"><div class="eyebrow">ASSESSMENT, REIMAGINED</div><h1>Thoughtful exams.<br>One message at a time.</h1><p>Create, deliver and mark assessments in the place your students already know. Start with AI, bring a PDF or build your own.</p></div><div class="login-proof">A private workspace for your teaching team.</div></section><section class="login-form-pane"><form class="login-form" id="loginForm"><div class="eyebrow">YOUR WORKSPACE</div><h2>Welcome back</h2><p>Sign in to manage your WhatsApp exams.</p>${errorText ? `<div class="notice error" style="margin-bottom:14px">${icons.info}<span>${escapeHtml(errorText)}</span></div>` : ''}<div class="field"><label for="loginEmail">Email address</label><input id="loginEmail" name="email" type="email" autocomplete="username" required placeholder="you@school.edu"></div><div class="field"><label for="loginPassword">Password</label><input id="loginPassword" name="password" type="password" autocomplete="current-password" required placeholder="Your workspace password"></div><button class="btn btn-primary" type="submit">Sign in ${icons.send}</button><div class="login-help">Workspace access is managed by your What Exam administrator. Credentials stay private and are never displayed in the app.</div></form></section></main>`;
}

function navButton(page, label, icon) {
  return `<button type="button" data-page="${page}" class="${state.page === page ? 'active' : ''}">${icons[icon]}<span class="nav-label">${label}</span></button>`;
}

function layout(content) {
  const pageTitle = ({ overview: 'Overview', exams: 'My exams', results: 'Results', settings: 'Settings', builder: state.draftId ? 'Edit exam' : 'Create exam', detail: 'Exam details' })[state.page] || 'Overview';
  app.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand"><div class="brand-mark"></div><div class="brand-name">What <span>Exam</span></div></div><div class="workspace-card"><div class="workspace-icon">${icons.school}</div><div class="workspace-copy"><strong>Exam workspace</strong><small>Private · WhatsApp delivery</small></div><span class="workspace-arrow" style="color:#9aa39b">⌄</span></div><div class="nav-caption">WORKSPACE</div><nav class="side-nav">${navButton('overview', 'Overview', 'grid')}${navButton('exams', 'My exams', 'file')}${navButton('results', 'Results', 'chart')}${navButton('settings', 'Settings', 'settings')}</nav><div class="sidebar-grow"></div><div class="side-help"><strong>Ready to go live?</strong><p>Connect your AI and WhatsApp credentials in your Render dashboard.</p><button type="button" data-page="settings">View connections →</button></div><div class="user-card"><div class="user-avatar">${initials(state.user?.email)}</div><div class="user-name"><strong>${escapeHtml(state.user?.email || 'Workspace admin')}</strong><small>Workspace admin</small></div><button type="button" data-action="logout" aria-label="Sign out">${icons.logout}</button></div></aside><main class="main"><header class="topbar"><div class="crumb">What Exam &nbsp; / &nbsp; <strong>${escapeHtml(pageTitle)}</strong></div>${state.page === 'exams' ? `<label class="top-search">${icons.search}<input id="searchInput" placeholder="Search exams…" value="${escapeHtml(state.search)}" aria-label="Search exams"></label>` : ''}<button type="button" class="top-user" data-action="logout" aria-label="Sign out" title="Sign out">${initials(state.user?.email)}</button></header><div class="content"><div class="page" id="pageContent">${content}</div></div></main></div>`;
}

function statCard(label, value, sub, icon) {
  return `<div class="stat"><div class="stat-label">${label}<span class="stat-icon">${icons[icon]}</span></div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-sub">${escapeHtml(sub)}</div></div>`;
}

function examTable(exams, emptyText = 'Your exams will appear here once you create your first one.') {
  const rows = exams.filter(exam => `${exam.title} ${exam.subject} ${exam.status}`.toLowerCase().includes(state.search.toLowerCase()));
  if (!rows.length) return `<section class="panel"><div class="empty"><div class="empty-symbol">${icons.file}</div><h3>${state.search ? 'No matching exams' : 'A clean slate'}</h3><p>${state.search ? 'Try a different search term.' : emptyText}</p>${state.search ? '' : button('Create your first exam', 'create', 'btn btn-primary btn-sm', 'plus')}</div></section>`;
  return `<section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Exam</th><th>Status</th><th>Questions</th><th>Responses</th><th>Updated</th><th></th></tr></thead><tbody>${rows.map(exam => `<tr><td><div class="exam-cell"><div class="subject-icon">${escapeHtml((exam.subject || 'EX').slice(0, 2).toUpperCase())}</div><div><strong>${escapeHtml(exam.title)}</strong><small>${escapeHtml(exam.subject || 'Subject not set')} · ${Number(exam.durationMinutes || 30)} min</small></div></div></td><td>${statusTag(exam.status)}</td><td>${Number(exam.questionCount ?? exam.questions?.length ?? 0)}</td><td>${Number(exam.completedCount ?? 0)} completed · ${Number(exam.sessionCount ?? 0)} started</td><td>${new Date(exam.updatedAt || exam.createdAt).toLocaleDateString()}</td><td><button type="button" class="table-link" data-action="open-exam" data-id="${exam.id}">Open →</button></td></tr>`).join('')}</tbody></table></div></section>`;
}

function overviewContent() {
  const d = state.dashboard || {};
  const missing = !d.config?.ai || !d.config?.whatsapp;
  return `<div class="page-heading"><div><div class="eyebrow">YOUR TEACHING SPACE</div><h1>Welcome to What Exam</h1><p>Your workspace is ready. Build an exam when you are.</p></div>${button('Create an exam', 'create', 'btn btn-primary', 'plus')}</div><div class="stats">${statCard('Exams created', d.exams || 0, 'Saved in this workspace', 'file')}${statCard('Live exams', d.live_exams || 0, 'Available for WhatsApp invites', 'send')}${statCard('Student invitations', d.invitations || 0, 'Sent through WhatsApp', 'school')}${statCard('Average mark', `${d.average_score || 0}%`, `${d.completed || 0} completed exam${Number(d.completed) === 1 ? '' : 's'}`, 'chart')}</div>${missing ? `<div class="notice warning" style="margin-bottom:17px">${icons.info}<span><strong>Finish connecting your services.</strong> Add your OpenAI key and WhatsApp Cloud API settings in Render to generate, publish and send live exams. ${button('Open settings', 'settings', 'btn btn-soft btn-sm')}</span></div>` : ''}<section class="hero"><div class="hero-copy"><div class="eyebrow">AI TO WHATSAPP</div><h2>Make assessment feel more human.</h2><p>Turn a learning goal or a source PDF into a carefully structured exam. Your students receive one question at a time in WhatsApp.</p>${button('Start creating', 'create', 'btn btn-primary', 'spark')}</div><div class="hero-visual"><div class="hero-step"><div class="hero-step-mark">${icons.spark}</div>Shape the exam</div><div class="hero-dash"></div><div class="hero-step"><div class="hero-step-mark">${icons.send}</div>Send on WhatsApp</div><div class="hero-dash"></div><div class="hero-step"><div class="hero-step-mark">${icons.chart}</div>Review marks</div></div></section><div class="section-heading"><h2>Recently updated</h2><button type="button" data-page="exams">All exams →</button></div>${examTable(state.exams.slice(0, 5))}`;
}

function examsContent() {
  return `<div class="page-heading"><div><div class="eyebrow">YOUR ASSESSMENTS</div><h1>My exams</h1><p>Create and manage your WhatsApp-first assessments.</p></div>${button('Create an exam', 'create', 'btn btn-primary', 'plus')}</div>${examTable(state.exams, 'Start with an AI-generated exam, upload a PDF, or write questions yourself.')}`;
}

function resultsContent() {
  const rows = state.results || [];
  return `<div class="page-heading"><div><div class="eyebrow">STUDENT PERFORMANCE</div><h1>Results</h1><p>Marks and completion from real WhatsApp exam sessions.</p></div></div>${rows.length ? `<section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Exam</th><th>Student</th><th>Score</th><th>Questions</th><th>Status</th><th>Started</th><th></th></tr></thead><tbody>${rows.map(result => `<tr><td><strong>${escapeHtml(result.examTitle)}</strong><small style="display:block;color:#99a39c;margin-top:3px">${escapeHtml(result.subject || '')}</small></td><td>+${escapeHtml(result.phone)}</td><td>${Number(result.score)}/${Number(result.totalPoints)}</td><td>${Number(result.answeredCount)}</td><td>${result.completed ? '<span class="status live">Completed</span>' : '<span class="status paused">In progress</span>'}</td><td>${new Date(result.startedAt).toLocaleString()}</td><td><button type="button" class="table-link" data-action="open-session" data-id="${result.id}">Review →</button></td></tr>`).join('')}</tbody></table></div></section>` : `<section class="panel"><div class="empty"><div class="empty-symbol">${icons.chart}</div><h3>No student results yet</h3><p>Once a student responds to an exam invitation, their completion and marks will be recorded here.</p></div></section>`}`;
}

function settingsContent() {
  const c = state.dashboard?.config || {};
  const configs = [
    ['AI exam generation & marking', 'OPENAI_API_KEY', c.ai, 'The key is used only on the server for exam creation, image marking and voice transcription.'],
    ['WhatsApp Cloud API', 'WHATSAPP_ACCESS_TOKEN', c.whatsapp, 'WhatsApp also needs the phone number ID, app secret, verify token and approved invite template name.'],
    ['Persistent exam storage', 'DATABASE_URL', c.database, 'Render Postgres stores exams, invitations, WhatsApp events and student marks.'],
  ];
  return `<div class="page-heading"><div><div class="eyebrow">WORKSPACE CONNECTIONS</div><h1>Settings</h1><p>Service status only. Secret values are never shown in the app.</p></div></div><div class="split"><section class="panel"><div class="panel-head"><div><strong>Connected services</strong><small>Manage credentials in the Render dashboard.</small></div></div><div class="form-card-body setting-list">${configs.map(([label, key, ready, description]) => `<div class="setting-row"><div><strong>${label} <span class="env-code">${key}</span></strong><small>${description}</small></div><span class="config-state ${ready ? 'ready' : 'missing'}">${ready ? 'Connected' : 'Needs setup'}</span></div>`).join('')}</div></section><section class="panel"><div class="panel-head"><div><strong>WhatsApp launch checklist</strong><small>Required for real delivery and student replies.</small></div></div><div class="form-card-body"><div class="notice">${icons.info}<span>Use a WhatsApp Business Cloud API phone number and a Meta-approved utility template with two body parameters: exam title and start code.</span></div><div style="height:10px"></div><div class="field-hint">Webhook callback URL</div><div class="env-code" style="display:block;margin-top:6px;overflow-wrap:anywhere">${escapeHtml(location.origin)}/webhooks/whatsapp</div><div class="field-hint" style="margin-top:9px">Subscribe the Meta app to the <strong>messages</strong> webhook field and use the same verify token stored in Render.</div></div></section></div>`;
}

function createContent() {
  return `<div class="builder-head"><button type="button" class="back-button" data-action="back">${icons.arrow}</button><div class="builder-title"><div class="eyebrow">NEW ASSESSMENT</div><h1>How would you like to start?</h1><p>Every generated or extracted question stays editable before it goes live.</p></div></div><div class="create-tabs"><button type="button" class="${state.createMethod === 'ai' ? 'active' : ''}" data-method="ai">${icons.spark} Generate with AI</button><button type="button" class="${state.createMethod === 'pdf' ? 'active' : ''}" data-method="pdf">${icons.upload} Import a PDF</button><button type="button" class="${state.createMethod === 'manual' ? 'active' : ''}" data-method="manual">${icons.file} Write manually</button></div>${state.createMethod === 'ai' ? `<section class="panel create-panel"><h2>Describe the exam you need</h2><p>What Exam will write an answer key and marking guidance along with each question.</p><form id="generateForm"><div class="field"><label for="brief">Exam brief</label><textarea id="brief" name="brief" required maxlength="1800" placeholder="e.g. Assess how well students understand photosynthesis, plant cell structure and the factors that affect the rate of photosynthesis."></textarea></div><div class="form-row"><div class="field"><label for="subject">Subject</label><input id="subject" name="subject" required maxlength="100" placeholder="Biology"></div><div class="field"><label for="level">Student level</label><input id="level" name="level" maxlength="100" placeholder="Year 10"></div></div><div class="count-row"><div class="field"><label for="objectiveCount">Objective questions</label><input id="objectiveCount" name="objectiveCount" type="number" min="0" max="40" value="8"></div><div class="field"><label for="theoryCount">Theory questions</label><input id="theoryCount" name="theoryCount" type="number" min="0" max="40" value="4"></div><div class="field"><label for="extra">Additional guidance</label><input id="extra" name="extra" maxlength="350" placeholder="Optional"></div></div><div class="field-hint" style="margin-top:9px">Choose between 1 and 40 questions. You can edit the questions and marking keys before saving.</div><div class="creation-bottom"><button class="btn btn-primary" type="submit">${icons.spark} Generate exam</button></div></form></section>` : state.createMethod === 'pdf' ? `<section class="panel create-panel"><h2>Extract questions from a PDF</h2><p>Upload an exam or worksheet. AI will identify the objective and theory questions across its pages, then prepare editable answers and marking guidance.</p><form id="importForm"><div class="field"><label for="pdfSubject">Subject <span style="font-weight:400;color:#9aa39c">(optional)</span></label><input id="pdfSubject" name="subject" maxlength="100" placeholder="e.g. Chemistry"></div><div class="file-drop" id="fileDrop"><div class="file-drop-icon">${icons.upload}</div><strong>Choose a PDF to upload</strong><p>Max 20 MB · PDF only · Scanned pages are supported</p><label class="btn btn-light btn-sm" for="pdfFile">Browse files</label><input id="pdfFile" name="pdf" type="file" accept="application/pdf,.pdf" required><div class="file-selected" id="fileSelected"></div></div><div class="field" style="margin-top:13px"><label for="pdfBrief">Extraction notes <span style="font-weight:400;color:#9aa39c">(optional)</span></label><input id="pdfBrief" name="brief" maxlength="500" placeholder="For example, which section or pages contain the exam?"></div><div class="creation-bottom"><button class="btn btn-primary" type="submit">${icons.upload} Extract questions</button></div></form></section>` : `<section class="panel create-panel"><h2>Build the exam yourself</h2><p>Start with a blank question editor and write each question and answer key.</p><div class="notice">${icons.info}<span>No sample questions are added. You will start with one empty question and can add as many as you need.</span></div><div class="creation-bottom">${button('Open the question editor', 'manual-start', 'btn btn-primary', 'file')}</div></section>`}`;
}

function questionCard(question, index) {
  const objective = question.kind === 'objective';
  const options = Array.isArray(question.options) ? question.options : [];
  return `<article class="question-card selected"><div class="question-head"><span class="q-index">${String(index + 1).padStart(2, '0')}</span><span class="q-name">${escapeHtml(question.text || 'Untitled question')}</span><span class="q-tag">${objective ? 'Objective' : 'Theory'}</span><span class="q-points">${Number(question.points || 1)} pt</span><button type="button" class="delete-q" aria-label="Remove question ${index + 1}" data-action="delete-question" data-index="${index}">${icons.trash}</button></div><div class="question-body"><div class="q-toolbar"><div class="segmented"><button type="button" class="${objective ? 'active' : ''}" data-action="set-kind" data-kind="objective" data-index="${index}">Objective</button><button type="button" class="${!objective ? 'active' : ''}" data-action="set-kind" data-kind="theory" data-index="${index}">Theory</button></div><label class="points-input">Points <input type="number" min="1" max="100" value="${Number(question.points || 1)}" data-qfield="points" data-index="${index}" aria-label="Question points"></label></div><div class="field"><label>Question</label><textarea data-qfield="text" data-index="${index}" maxlength="3000" placeholder="Write the question clearly…">${escapeHtml(question.text)}</textarea></div>${objective ? `<div class="options-list">${options.map((option, optionIndex) => `<div class="option-row"><span class="option-letter">${String.fromCharCode(65 + optionIndex)}</span><input type="text" maxlength="600" value="${escapeHtml(option)}" data-option="${optionIndex}" data-index="${index}" placeholder="Answer option ${optionIndex + 1}"><input class="correct-radio" type="radio" name="correct-${index}" aria-label="Mark option ${String.fromCharCode(65 + optionIndex)} as correct" ${Number(question.correctOption) === optionIndex ? 'checked' : ''} data-action="correct-option" data-index="${index}" data-option="${optionIndex}"></div>`).join('')}</div><button type="button" class="add-option" data-action="add-option" data-index="${index}" ${options.length >= 6 ? 'disabled' : ''}>+ Add another option</button><div class="field" style="margin-top:9px"><label>Answer explanation <span style="font-weight:400;color:#98a29a">(optional)</span></label><input type="text" data-qfield="answer" data-index="${index}" maxlength="1500" value="${escapeHtml(question.answer || '')}" placeholder="Why this is the correct choice"></div>` : `<div class="field" style="margin-top:10px"><label>Allowed response methods</label><div class="mode-options">${[['text', 'Typed answer'], ['photo', 'Photo of written work'], ['audio', 'Voice note']].map(([mode, label]) => `<label class="mode-chip"><input type="checkbox" data-mode="${mode}" data-index="${index}" ${(question.modes || []).includes(mode) ? 'checked' : ''}>${label}</label>`).join('')}</div></div><div class="field" style="margin-top:10px"><label>Reference answer</label><textarea data-qfield="answer" data-index="${index}" maxlength="1500" placeholder="A concise model answer for AI marking…">${escapeHtml(question.answer || '')}</textarea></div><div class="field" style="margin-top:10px"><label>Marking guidance</label><textarea data-qfield="rubric" data-index="${index}" maxlength="3000" placeholder="What earns full, partial or no credit?">${escapeHtml(question.rubric || '')}</textarea></div>`}${question.reviewRequired ? `<div class="review-flag"><span>Review needed · confirm the answer key before publishing.</span><button type="button" data-action="confirm-question" data-index="${index}">I reviewed this</button></div>` : ''}</div></article>`;
}

function renderPhonePreview() {
  const draft = state.draft;
  if (!draft) return '';
  const index = Math.max(0, Math.min(state.previewIndex || 0, draft.questions.length - 1));
  const question = draft.questions[index];
  const title = draft.title || 'Your exam';
  const questionText = question?.text || 'Your question will appear here as you write it.';
  const optionMarkup = question?.kind === 'objective' ? `<div class="wa-options">${(question.options || []).filter(Boolean).map((option, i) => `<div class="wa-choice"><b>${String.fromCharCode(65 + i)}</b> ${escapeHtml(option)}</div>`).join('')}</div>` : `<div class="wa-hint">${(question?.modes || []).map(mode => ({ text: 'type an answer', photo: 'attach a photo', audio: 'send a voice note' })[mode]).filter(Boolean).join(' · ') || 'Reply with your answer'}</div>`;
  const chat = document.getElementById('previewChat');
  if (chat) chat.innerHTML = `<div class="wa-date">TODAY</div><div class="wa-bubble"><strong>${escapeHtml(title)}</strong><br>${escapeHtml(draft.instructions || 'Welcome. You will receive one question at a time. Send each answer when you are ready.')}<div class="wa-time">Now</div></div><div class="wa-bubble">${escapeHtml(questionText)}${optionMarkup}<div class="wa-time">Now</div></div>`;
  const counter = document.getElementById('previewCounter');
  if (counter) counter.textContent = draft.questions.length ? `Question ${index + 1} of ${draft.questions.length}` : 'Add a question to preview';
}

function editorContent() {
  const draft = state.draft || newDraft();
  const total = draft.questions.reduce((sum, question) => sum + Number(question.points || 0), 0);
  return `<div class="builder-head"><button type="button" class="back-button" data-action="back">${icons.arrow}</button><div class="builder-title"><div class="eyebrow">EXAM STUDIO</div><h1>${state.draftId ? 'Edit exam' : 'Review your exam'}</h1><p>Check questions, correct answers and marking guidance before saving.</p></div><div class="builder-actions">${button('Save draft', 'save-exam', 'btn btn-light btn-sm')}${state.draftId ? '' : ''}</div></div><div class="editor-grid"><div class="editor-main"><section class="form-card"><div class="form-card-head"><div><strong>Exam details</strong><small>These details help students understand what they are taking.</small></div></div><div class="form-card-body"><div class="form-row"><div class="field"><label>Exam title</label><input type="text" maxlength="160" data-field="title" value="${escapeHtml(draft.title)}" placeholder="e.g. Cell biology assessment"></div><div class="field"><label>Subject</label><input type="text" maxlength="100" data-field="subject" value="${escapeHtml(draft.subject)}" placeholder="e.g. Biology"></div></div><div class="form-row" style="margin-top:12px"><div class="field"><label>Level</label><input type="text" maxlength="100" data-field="level" value="${escapeHtml(draft.level)}" placeholder="e.g. Year 10"></div><div class="field"><label>Time limit · minutes</label><input type="number" min="5" max="360" data-field="durationMinutes" value="${Number(draft.durationMinutes || 30)}"></div></div><div class="form-row" style="margin-top:12px"><div class="field"><label>Pass mark · percent</label><input type="number" min="0" max="100" data-field="passMark" value="${Number(draft.passMark ?? 60)}"></div><div class="field"><label>Student instructions</label><input type="text" maxlength="500" data-field="instructions" value="${escapeHtml(draft.instructions || '')}" placeholder="Optional note before the first question"></div></div></div></section><section class="form-card"><div class="form-card-head"><div><strong>Questions</strong><small>Objective questions are checked automatically. Theory answers are marked against your reference and rubric.</small></div><span class="q-tag">${draft.questions.length} total</span></div><div id="questionList">${draft.questions.map(questionCard).join('')}</div><button type="button" class="add-q" data-action="add-question">+ Add a question</button><div class="total-points"><span>Maximum score</span><b>${total} points</b></div></section><div class="creation-bottom"><button type="button" class="btn btn-light" data-action="back">Cancel</button><button type="button" class="btn btn-primary" data-action="save-exam">Save draft</button></div></div><section class="panel preview-card"><div class="preview-top"><div><strong>WhatsApp preview</strong><small>Live view of the current question.</small></div><span class="live-indicator">Preview</span></div><div class="phone-stage"><div class="phone"><div class="phone-notch"></div><div class="wa-head"><span class="wa-back">‹</span><div class="wa-avatar">W</div><div class="wa-contact"><strong>What Exam</strong><small>Business account</small></div><span style="color:#3d7751;font-size:10px">•••</span></div><div class="wa-chat" id="previewChat"></div><div class="wa-composer"><div class="wa-add">＋</div><div class="wa-input-look">Type a message</div><div class="wa-send-look">➤</div></div></div></div><div class="preview-caption" id="previewCounter"></div></section></div>`;
}

function detailContent() {
  const exam = state.detail?.exam;
  if (!exam) return `<div class="loading"><div><div class="spinner"></div>Loading exam…</div></div>`;
  const sessions = state.detail.sessions || [];
  const invites = state.detail.invitations || [];
  const totalPoints = (exam.questions || []).reduce((sum, question) => sum + Number(question.points || 0), 0);
  return `<div class="builder-head"><button type="button" class="back-button" data-action="back">${icons.arrow}</button><div class="builder-title"><div class="eyebrow">${escapeHtml(exam.subject || 'EXAM')}</div><h1>${escapeHtml(exam.title)}</h1><p>${escapeHtml(exam.level || 'Student level not set')} · ${Number(exam.durationMinutes)} minutes · ${exam.questions.length} questions</p></div><div class="builder-actions">${exam.status === 'draft' ? button('Edit exam', 'edit-exam', 'btn btn-light btn-sm') : ''}${exam.status === 'draft' ? button('Publish exam', 'publish-exam', 'btn btn-primary btn-sm', 'send') : ''}${exam.status === 'live' ? button('Invite students', 'invite', 'btn btn-primary btn-sm', 'plus') : ''}${exam.status !== 'draft' ? button(exam.status === 'live' ? 'Pause' : 'Resume', 'toggle-pause', 'btn btn-light btn-sm') : ''}<button type="button" class="btn btn-quiet btn-sm" data-action="delete-exam">${icons.trash}</button></div></div><div style="margin-bottom:14px">${statusTag(exam.status)} <span style="font-size:9px;color:#8c978f;margin-left:7px">${totalPoints} points · pass mark ${Number(exam.passMark)}%</span></div>${exam.status === 'live' ? `<div class="notice" style="margin-bottom:14px">${icons.info}<span>This exam is live. Send a WhatsApp invitation using the approved template. Students start by replying <strong>START</strong> and the 8-character code.</span></div>` : ''}<div class="detail-grid"><div class="editor-main"><section class="panel"><div class="panel-head"><div><strong>Student responses</strong><small>Marks and completion are recorded from WhatsApp replies.</small></div><span class="q-tag">${sessions.length} started</span></div>${sessions.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Student phone</th><th>Score</th><th>Answers</th><th>Status</th><th></th></tr></thead><tbody>${sessions.map(session => `<tr><td>+${escapeHtml(session.phone)}</td><td>${Number(session.score)}/${Number(session.totalPoints)}</td><td>${Number(session.answeredCount)} / ${exam.questions.length}</td><td>${session.completed ? '<span class="status live">Completed</span>' : '<span class="status paused">In progress</span>'}</td><td><button type="button" class="table-link" data-action="open-session" data-id="${session.id}">Review →</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><div class="empty-symbol">${icons.chart}</div><h3>No responses yet</h3><p>Once a student starts this exam in WhatsApp, their progress will appear here.</p></div>`}</section><section class="panel"><div class="panel-head"><div><strong>Invitation activity</strong><small>WhatsApp delivery status for student invitations.</small></div><span class="q-tag">${invites.length} sent</span></div>${invites.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Phone</th><th>Status</th><th>Sent</th></tr></thead><tbody>${invites.map(invite => `<tr><td>+${escapeHtml(invite.phone)}</td><td>${escapeHtml(invite.status)}</td><td>${new Date(invite.createdAt).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><h3>No invitations sent</h3><p>${exam.status === 'live' ? 'Invite a student to begin.' : 'Publish the exam first, then invite a student.'}</p></div>`}</section></div><aside class="panel"><div class="panel-head"><div><strong>Exam overview</strong><small>Saved assessment content.</small></div></div><div class="detail-meta"><div class="detail-stat"><span>Questions</span><strong>${exam.questions.length}</strong></div><div class="detail-stat"><span>Points</span><strong>${totalPoints}</strong></div><div class="detail-stat"><span>Completed</span><strong>${sessions.filter(s => s.completed).length}</strong></div></div><div class="form-card-body"><div class="field-hint">Created ${new Date(exam.createdAt).toLocaleDateString()}</div>${exam.instructions ? `<div class="notice" style="margin-top:12px">${icons.info}<span>${escapeHtml(exam.instructions)}</span></div>` : ''}</div></aside></div>`;
}

function render() {
  if (!state.user) return renderLogin();
  let content = '';
  if (state.page === 'overview') content = overviewContent();
  else if (state.page === 'exams') content = examsContent();
  else if (state.page === 'results') content = resultsContent();
  else if (state.page === 'settings') content = settingsContent();
  else if (state.page === 'create') content = createContent();
  else if (state.page === 'builder') content = editorContent();
  else if (state.page === 'detail') content = detailContent();
  layout(content);
  if (state.page === 'builder') renderPhonePreview();
}

async function refreshPage() {
  render();
  try {
    if (state.page === 'overview') {
      const [dashboard, exams] = await Promise.all([request('/api/dashboard'), request('/api/exams')]);
      state.dashboard = dashboard;
      state.exams = exams.exams;
    } else if (state.page === 'exams') {
      const data = await request('/api/exams'); state.exams = data.exams;
    } else if (state.page === 'results') {
      const data = await request('/api/results'); state.results = data.results;
    } else if (state.page === 'settings') {
      state.dashboard = await request('/api/dashboard');
    } else if (state.page === 'detail' && state.detail?.exam?.id) {
      state.detail = await request(`/api/exams/${state.detail.exam.id}`);
    }
    render();
  } catch (error) {
    if (error.message) toast(error.message);
  }
}

function navigate(page) {
  state.page = page;
  state.search = '';
  state.draft = null;
  state.draftId = null;
  if (page !== 'detail') state.detail = null;
  refreshPage();
}

function createExam() {
  state.page = 'create';
  state.createMethod = 'ai';
  state.draft = null;
  state.draftId = null;
  render();
}

function openEditor(exam = null) {
  state.draftId = exam?.id || null;
  state.draft = exam ? structuredClone(exam) : newDraft();
  if (!Array.isArray(state.draft.questions)) state.draft.questions = [];
  state.previewIndex = 0;
  state.page = 'builder';
  render();
}

async function openExam(id) {
  try {
    state.detail = await request(`/api/exams/${id}`);
    state.page = 'detail';
    render();
  } catch (error) { toast(error.message); }
}

function renderInviteModal() {
  const exam = state.detail?.exam;
  if (!exam) return;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modalBackdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="inviteTitle"><div class="modal-head"><h2 id="inviteTitle">Invite a student</h2><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><form class="modal-body" id="inviteForm" data-exam-id="${exam.id}"><div class="notice" style="margin-bottom:14px">${icons.send}<span><strong>${escapeHtml(exam.title)}</strong><br>The approved WhatsApp template will invite the student to reply START with a private exam code.</span></div><div class="field"><label for="studentPhone">Student WhatsApp number</label><input id="studentPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+353 87 123 4567"><div class="field-hint">Include the country code. Numbers are stored for exam delivery and results.</div></div><label class="consent"><input type="checkbox" name="consentConfirmed" required><span>The student has agreed to receive WhatsApp exam messages from this workspace.</span></label><div class="modal-actions"><button type="button" class="btn btn-light" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Send invitation ${icons.send}</button></div></form></section></div>`);
}

async function openSessionResult(id) {
  try {
    const data = await request(`/api/sessions/${id}`);
    const session = data.session;
    const answers = data.answers || [];
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modalBackdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="resultTitle"><div class="modal-head"><div><h2 id="resultTitle">Student result</h2><div class="field-hint">${escapeHtml(session.title)} · +${escapeHtml(session.phone)}</div></div><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><div class="notice" style="margin-bottom:13px">${icons.chart}<span>Final score <strong>${Number(session.score)}/${Number(session.totalPoints)}</strong> · ${session.completed ? 'Completed' : 'In progress'} · Started ${new Date(session.startedAt).toLocaleString()}</span></div>${answers.map(answer => { const question = answer.question || {}; const key = question.kind === 'objective' ? question.options?.[question.correctOption] || 'Not set' : question.answer || 'No reference answer'; return `<article class="answer-review"><div class="answer-review-top"><strong>Question ${Number(answer.questionIndex) + 1}</strong><span>${Number(answer.score)}/${Number(answer.maxPoints)} points</span></div><p class="answer-review-question">${escapeHtml(question.text || '')}</p><div class="answer-review-answer"><span>Student answer</span><p>${answer.mediaId ? 'Photo response received and reviewed by AI.' : escapeHtml(answer.answer || 'No text answer')}</p>${answer.transcript ? `<small>Voice transcription: ${escapeHtml(answer.transcript)}</small>` : ''}</div><div class="answer-review-key"><span>${question.kind === 'objective' ? 'Correct option' : 'Reference answer'}</span><p>${escapeHtml(key)}</p></div><div class="answer-review-feedback">${escapeHtml(answer.feedback || '')}</div></article>`; }).join('') || '<div class="empty"><h3>No answers submitted yet</h3></div>'}<div class="modal-actions"><button type="button" class="btn btn-light" data-action="close-modal">Close</button></div></div></section></div>`);
  } catch (error) { toast(error.message); }
}
function updateEditorPreview() {
  const titleNode = document.querySelector('[data-field="title"]');
  const title = state.draft?.title || titleNode?.value || '';
  if (titleNode && title !== state.draft.title) state.draft.title = title;
  renderPhonePreview();
}

async function runGenerate(form) {
  const data = new FormData(form);
  const objectiveCount = Number(data.get('objectiveCount') || 0);
  const theoryCount = Number(data.get('theoryCount') || 0);
  const count = objectiveCount + theoryCount;
  if (!count || count > 40) throw new Error('Choose a total of 1 to 40 questions.');
  const response = await request('/api/exams/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief: data.get('brief'), subject: data.get('subject'), level: data.get('level'), extra: data.get('extra'), count, objectiveCount, theoryCount }),
  });
  openEditor(response.exam);
  toast('Your questions are ready. Review the answer keys before saving.');
}

async function runImport(form) {
  const file = form.querySelector('input[name="pdf"]')?.files?.[0];
  if (!file) throw new Error('Choose a PDF first.');
  const body = new FormData();
  body.append('pdf', file);
  body.append('subject', form.querySelector('[name="subject"]')?.value || '');
  body.append('brief', form.querySelector('[name="brief"]')?.value || '');
  const response = await request('/api/exams/import', { method: 'POST', body });
  openEditor(response.exam);
  toast(`Extracted ${response.exam.questions.length} questions from the PDF. Review the answer keys before saving.`);
}

async function saveDraft() {
  if (!state.draft) return;
  const body = {
    ...state.draft,
    title: document.querySelector('[data-field="title"]')?.value ?? state.draft.title,
    subject: document.querySelector('[data-field="subject"]')?.value ?? state.draft.subject,
    level: document.querySelector('[data-field="level"]')?.value ?? state.draft.level,
    instructions: document.querySelector('[data-field="instructions"]')?.value ?? state.draft.instructions,
    durationMinutes: Number(document.querySelector('[data-field="durationMinutes"]')?.value ?? state.draft.durationMinutes),
    passMark: Number(document.querySelector('[data-field="passMark"]')?.value ?? state.draft.passMark),
  };
  const response = await request(state.draftId ? `/api/exams/${state.draftId}` : '/api/exams', {
    method: state.draftId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  toast('Exam draft saved.');
  await openExam(response.exam.id);
}

async function submitAction(action, buttonNode) {
  if (state.busy) return;
  state.busy = true;
  const original = buttonNode?.innerHTML;
  if (buttonNode) { buttonNode.disabled = true; buttonNode.textContent = 'Working…'; }
  try { await action(); }
  catch (error) { toast(error.message); }
  finally {
    state.busy = false;
    if (buttonNode?.isConnected) { buttonNode.disabled = false; if (original) buttonNode.innerHTML = original; }
  }
}

document.addEventListener('click', event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) { navigate(pageButton.dataset.page); return; }
  const methodButton = event.target.closest('[data-method]');
  if (methodButton) { state.createMethod = methodButton.dataset.method; render(); return; }
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  const index = Number(actionButton.dataset.index);
  if (action === 'create') createExam();
  else if (action === 'settings') navigate('settings');
  else if (action === 'back') navigate(state.detail ? 'exams' : state.draftId ? 'exams' : 'exams');
  else if (action === 'manual-start') openEditor();
  else if (action === 'open-exam') openExam(actionButton.dataset.id);
  else if (action === 'edit-exam' && state.detail?.exam) openEditor(state.detail.exam);
  else if (action === 'add-question') { state.draft.questions.push(newQuestion()); render(); }
  else if (action === 'delete-question') { state.draft.questions.splice(index, 1); render(); }
  else if (action === 'set-kind') { const question = state.draft.questions[index]; question.kind = actionButton.dataset.kind; question.options = question.kind === 'objective' ? ['', '', '', ''] : []; question.correctOption = 0; question.modes = question.kind === 'theory' ? ['text', 'photo', 'audio'] : []; question.reviewRequired = false; render(); }
  else if (action === 'add-option') { if (state.draft.questions[index].options.length < 6) { state.draft.questions[index].options.push(''); render(); } }
  else if (action === 'confirm-question') { state.draft.questions[index].reviewRequired = false; render(); }
  else if (action === 'save-exam') submitAction(saveDraft, actionButton);
  else if (action === 'publish-exam') submitAction(async () => { const result = await request(`/api/exams/${state.detail.exam.id}/publish`, { method: 'POST' }); state.detail.exam = result.exam; render(); toast('Exam is live. You can now invite students through WhatsApp.'); }, actionButton);
  else if (action === 'toggle-pause') submitAction(async () => { const result = await request(`/api/exams/${state.detail.exam.id}/pause`, { method: 'POST' }); state.detail = await request(`/api/exams/${result.exam.id}`); render(); toast(result.exam.status === 'paused' ? 'Exam paused.' : 'Exam is live again.'); }, actionButton);
  else if (action === 'invite') renderInviteModal();
  else if (action === 'open-session') openSessionResult(actionButton.dataset.id);
  else if (action === 'close-modal') document.getElementById('modalBackdrop')?.remove();
  else if (action === 'delete-exam') submitAction(async () => { if (!window.confirm('Delete this exam and its invitations, sessions and marks? This cannot be undone.')) return; await request(`/api/exams/${state.detail.exam.id}`, { method: 'DELETE' }); state.detail = null; state.page = 'exams'; await refreshPage(); toast('Exam and related records deleted.'); }, actionButton);
  else if (action === 'logout') submitAction(async () => { await request('/api/auth/logout', { method: 'POST' }); state.user = null; state.page = 'overview'; render(); }, actionButton);
  else if (action === 'correct-option') { const question = state.draft.questions[index]; question.correctOption = Number(actionButton.dataset.option); question.reviewRequired = false; render(); }
});

document.addEventListener('input', event => {
  const node = event.target;
  if (node.id === 'searchInput') { state.search = node.value; const selection = node.selectionStart; const content = document.getElementById('pageContent'); if (content) content.innerHTML = state.page === 'exams' ? examsContent() : content.innerHTML; node.setSelectionRange(selection, selection); return; }
  if (node.dataset.field && state.draft) {
    const key = node.dataset.field;
    state.draft[key] = ['durationMinutes', 'passMark'].includes(key) ? Number(node.value) : node.value;
    if (key === 'title' || key === 'instructions') renderPhonePreview();
  }
  if (node.dataset.qfield && state.draft) {
    const q = state.draft.questions[Number(node.dataset.index)];
    q[node.dataset.qfield] = node.dataset.qfield === 'points' ? Number(node.value) : node.value;
    if (node.dataset.qfield === 'text') {
      const header = node.closest('.question-card')?.querySelector('.q-name');
      if (header) header.textContent = node.value || 'Untitled question';
      renderPhonePreview();
    }
    const total = document.querySelector('.total-points b');
    if (total) total.textContent = `${state.draft.questions.reduce((sum, question) => sum + Number(question.points || 0), 0)} points`;
  }
  if (node.dataset.option !== undefined && state.draft) {
    state.draft.questions[Number(node.dataset.index)].options[Number(node.dataset.option)] = node.value;
    renderPhonePreview();
  }
});

document.addEventListener('change', event => {
  const node = event.target;
  if (node.dataset.mode && state.draft) {
    const q = state.draft.questions[Number(node.dataset.index)];
    q.modes = node.checked ? [...new Set([...q.modes, node.dataset.mode])] : q.modes.filter(mode => mode !== node.dataset.mode); renderPhonePreview();
  }
  if (node.id === 'pdfFile' && node.files?.[0]) {
    const label = document.getElementById('fileSelected');
    if (label) label.textContent = `${node.files[0].name} · ${(node.files[0].size / 1024 / 1024).toFixed(1)} MB`;
  }
});

document.addEventListener('dragover', event => { if (event.target.closest('#fileDrop')) { event.preventDefault(); document.getElementById('fileDrop')?.classList.add('dragover'); } });
document.addEventListener('dragleave', event => { if (event.target.closest('#fileDrop')) document.getElementById('fileDrop')?.classList.remove('dragover'); });
document.addEventListener('drop', event => {
  const drop = event.target.closest('#fileDrop');
  if (!drop) return;
  event.preventDefault(); drop.classList.remove('dragover');
  const file = event.dataTransfer.files?.[0];
  const input = document.getElementById('pdfFile');
  if (file && input && file.type === 'application/pdf') {
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    document.getElementById('fileSelected').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  } else toast('Choose a PDF file.');
});

document.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  const submitButton = form.querySelector('button[type="submit"]');
  if (form.id === 'loginForm') submitAction(async () => {
    const data = new FormData(form);
    const result = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) });
    state.user = result.user; state.page = 'overview'; await refreshPage();
  }, submitButton);
  else if (form.id === 'generateForm') submitAction(() => runGenerate(form), submitButton);
  else if (form.id === 'importForm') submitAction(() => runImport(form), submitButton);
  else if (form.id === 'inviteForm') submitAction(async () => {
    const data = new FormData(form);
    await request(`/api/exams/${form.dataset.examId}/invitations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: data.get('phone'), consentConfirmed: data.get('consentConfirmed') === 'on' }) });
    document.getElementById('modalBackdrop')?.remove();
    state.detail = await request(`/api/exams/${form.dataset.examId}`); render(); toast('WhatsApp invitation sent.');
  }, submitButton);
});

async function boot() {
  try {
    const response = await request('/api/auth/me');
    state.user = response.user;
    await refreshPage();
  } catch {
    state.user = null;
    render();
  }
}
boot();
