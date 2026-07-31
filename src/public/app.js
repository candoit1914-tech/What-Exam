/* La_Exam admin dashboard — vanilla JS SPA */

const API_BASE = (window.API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const $view = document.getElementById('view');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast hidden'), 3200);
}

function badge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

async function openModal(title, bodyHTML) {
  return new Promise((resolve) => {
    const div = document.createElement('div');
    div.className = 'modal-backdrop';
    div.innerHTML = `<div class="modal">
      <h3>${esc(title)}</h3>
      ${bodyHTML}
      <div class="row modal-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="ghost" data-act="cancel">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(div);
    div.addEventListener('click', (e) => {
      if (e.target === div || e.target.closest('[data-act="cancel"]')) {
        div.remove();
      }
    });
    resolve(div);
  });
}

// ── Router ─────────────────────────────────────────────────────────────

const routes = {
  '': renderDashboard,
  '/': renderDashboard,
  '/exams': renderExams,
  '/exams/:id': renderExam,
  '/results': renderResults,
  '/results/:id': renderResultDetail,
  '/students': renderStudents,
};

function router() {
  const hash = (location.hash || '#/').replace(/^#/, '');
  const parts = hash.split('/').filter(Boolean);
  const id = parts[1];
  const key = '/' + parts[0] + (id ? '/:id' : '');
  const match = routes[key];
  if (match) match(id);
  else renderDashboard();
}

window.addEventListener('hashchange', router);

// ── Dashboard ──────────────────────────────────────────────────────────

async function renderDashboard() {
  const s = await api('/api/stats');
  $view.innerHTML = `
    <h1>Dashboard</h1>
    <p class="muted">Overview of your examination system</p>
    <div class="grid">
      <div class="stat"><b>${s.exams}</b><span>Exams</span></div>
      <div class="stat"><b>${s.published}</b><span>Live</span></div>
      <div class="stat"><b>${s.questions}</b><span>Questions</span></div>
      <div class="stat"><b>${s.students}</b><span>Students</span></div>
      <div class="stat"><b>${s.active}</b><span>Active sessions</span></div>
      <div class="stat"><b>${s.sessions}</b><span>Total attempts</span></div>
    </div>
    ${s.reviews ? `<div class="card" style="border-color:#fde68a">⚠️ <b>${s.reviews}</b> theory answer(s) pending AI/manual review. <a href="#/results">Review now</a></div>` : ''}
    <div class="card row">
      <div>
        <b>Create a new exam</b>
        <div class="muted">Manual, AI-generated, or from a PDF. The marking scheme is created automatically.</div>
      </div>
      <button onclick="location.hash='#/exams'">Go to Exams</button>
    </div>`;
}

// ── Exams list ─────────────────────────────────────────────────────────

async function renderExams() {
  const exams = await api('/api/exams');
  $view.innerHTML = `
    <div class="spread">
      <div><h1>Exams</h1><p class="muted">${exams.length} exam(s) created</p></div>
      <button onclick="createExam()">+ New Exam</button>
    </div>
    <div class="card"><table>
      <thead><tr><th>Title</th><th>Subject</th><th>Status</th><th>Questions</th><th>Marks</th><th>Students</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${exams.map((e) => `<tr>
          <td><a href="#/exams/${e.id}" style="font-weight:600;color:var(--primary)">${esc(e.title)}</a></td>
          <td>${esc(e.subject) || '—'}</td>
          <td>${badge(e.status)}</td>
          <td>${e.question_count}</td>
          <td>${e.total_marks}</td>
          <td>${e.sessions_total} <span class="muted">(${e.sessions_active} active)</span></td>
          <td class="muted">${e.created_at}</td>
          <td><a href="#/exams/${e.id}"><button class="small">Open</button></a></td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">No exams yet. Create one to get started.</td></tr>'}
      </tbody>
    </table></div>`;
}

async function createExam() {
  const bodyHTML = `
    <div class="field"><label>Title</label><input type="text" id="ne_title" placeholder="e.g. End of Term Science Exam"></div>
    <div class="field"><label>Subject</label><input type="text" id="ne_subject" placeholder="e.g. Integrated Science"></div>
    <div class="field"><label>Duration (minutes)</label><input type="number" id="ne_duration" value="30"></div>
    <div class="field"><label>Pass mark (%)</label><input type="number" id="ne_pass" value="50"></div>
    <div class="row" style="justify-content:flex-end">
      <button id="ne_save">Create</button>
    </div>`;
  await openModal('New Exam', bodyHTML);
  const btn = document.querySelector('#ne_save');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const body = {
      title: document.querySelector('#ne_title').value,
      subject: document.querySelector('#ne_subject').value,
      duration_minutes: document.querySelector('#ne_duration').value,
      pass_percentage: document.querySelector('#ne_pass').value,
    };
    try {
      const { id } = await api('/api/exams', { method: 'POST', body });
      document.querySelector('.modal-backdrop').remove();
      location.hash = `#/exams/${id}`;
    } catch (e) { toast(e.message, true); }
  });
}

// ── Exam editor ────────────────────────────────────────────────────────

let examState = { tab: 'questions' };

async function renderExam(id) {
  const data = await api(`/api/exams/${id}`);
  examState.id = id;
  examState.data = data;

  const { exam, questions, recipients, results } = data;
  $view.innerHTML = `
    <div class="spread">
      <div>
        <h1>${esc(exam.title)}</h1>
        <p class="muted">${esc(exam.subject)} · ${exam.question_count} questions · ${exam.total_marks} marks · ${exam.duration_minutes} min · pass ${exam.pass_percentage}% · ${badge(exam.status)}</p>
      </div>
      <div class="row">
        ${exam.status === 'draft' ? `<button onclick="publishExam(${exam.id})">Publish</button>` : ''}
        ${exam.status === 'live' ? `<button class="ghost" onclick="endExam(${exam.id})">End Exam</button>` : ''}
        <button class="ghost" onclick="editExamMeta(${exam.id})">Edit</button>
        <button class="ghost danger" onclick="deleteExam(${exam.id})">Delete</button>
      </div>
    </div>
    <div class="tabbar">
      <button class="tab ${examState.tab === 'questions' ? 'active' : ''}" onclick="setTab('questions')">Questions</button>
      <button class="tab ${examState.tab === 'schemes' ? 'active' : ''}" onclick="setTab('schemes')">Marking Scheme</button>
      <button class="tab ${examState.tab === 'recipients' ? 'active' : ''}" onclick="setTab('recipients')">Recipients (${recipients.length})</button>
      <button class="tab ${examState.tab === 'results' ? 'active' : ''}" onclick="setTab('results')">Results (${results.length})</button>
    </div>
    <div id="tabbody"></div>`;
  renderTab();
}

function setTab(tab) {
  examState.tab = tab;
  renderExam(examState.id);
}

async function renderTab() {
  const bodyEl = document.getElementById('tabbody');
  const { exam, questions, recipients, results } = examState.data;
  const id = examState.id;
  const tab = examState.tab;

  if (tab === 'questions') {
    bodyEl.innerHTML = `
      <div class="row" style="margin:12px 0">
        <button onclick="addQuestionForm(${id})">+ Add Question</button>
        <button class="ghost" onclick="aiGenerateForm(${id})">✨ AI Generate</button>
        <button class="ghost" onclick="pdfUploadForm(${id})">📄 Upload PDF</button>
      </div>
      ${questions.length === 0 ? '<div class="card muted">No questions yet. Add manually, generate with AI, or upload a PDF.</div>' : ''}
      ${questions.map(q => qitemHTML(q, id)).join('')}`;
  } else if (tab === 'schemes') {
    bodyEl.innerHTML = questions.length === 0
      ? '<div class="card muted">No questions yet.</div>'
      : questions.map((q) => schemeHTML(q, id)).join('');
  } else if (tab === 'recipients') {
    bodyEl.innerHTML = `
      <div class="card">
        <label>Student phone numbers (comma or newline separated, any country format)</label>
        <textarea id="phones_input" placeholder="+233 24 123 4567&#10;0541234567&#10;+1 555 123 4567"></textarea>
        <div class="row" style="margin-top:10px">
          <button onclick="addRecipients(${id})">Add Recipients</button>
          <button class="ghost" onclick="sendExam(${id})">📤 Send Exam to Recipients</button>
        </div>
      </div>
      <div class="card"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Sent</th><th></th></tr></thead>
        <tbody>
          ${recipients.map((r) => `<tr>
            <td>${esc(r.name || '—')}</td>
            <td>${esc(r.phone)}</td>
            <td class="muted">${esc(r.sent_at || '—')}</td>
            <td><button class="small danger" onclick="removeRecipient(${id}, ${r.id})">Remove</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  } else if (tab === 'results') {
    bodyEl.innerHTML = `<div class="card"><table>
      <thead><tr><th>Student</th><th>Phone</th><th>Score</th><th>%</th><th>Result</th><th>Status</th><th>Started</th><th></th></tr></thead>
      <tbody>
        ${results.map((s) => {
          const finished = ['completed', 'expired'].includes(s.status);
          const pct = finished ? (s.final_percentage != null ? s.final_percentage + '%' : '—') : '—';
          return `<tr>
            <td>${esc(s.student_name || '—')}</td>
            <td>${esc(s.phone)}</td>
            <td>${finished ? `${s.final_score}` : '—'}</td>
            <td>${pct}</td>
            <td>${finished ? (s.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>') : badge(s.status)}</td>
            <td>${badge(s.status)}</td>
            <td class="muted">${s.started_at}</td>
            <td class="row">
              ${finished ? `<a href="${API_BASE}/report/${s.id}" target="_blank"><button class="small">Report</button></a>
              <button class="small ghost" onclick="resendResult(${s.id})">Resend</button>` : ''}
              <a href="#/results/${s.id}"><button class="small ghost">Details</button></a>
            </td>
          </tr>`;
        }).join('') || '<tr><td colspan="8" class="muted">No sessions yet. Send the exam to recipients to begin.</td></tr>'}
      </tbody>
    </table></div>`;
  }
}

function qitemHTML(q, id) {
  const opts = q.options || [];
  return `<div class="qitem">
    <div class="qhead">
      <div>
        <div class="muted">Q${q.q_order} · ${q.type} · ${q.marks} mark(s) · ${q.difficulty} · <span class="badge draft">${q.source}</span></div>
        <div class="qtext">${esc(q.text)}</div>
        <div class="opts-list">
          ${opts.map((o) => `<div class="${o.key === q.correct_answer ? 'correct' : ''}">${o.key}. ${esc(o.text)}${o.key === q.correct_answer ? ' ✓' : ''}</div>`).join('')}
        </div>
        ${q.learning_objective ? `<div class="muted" style="margin-top:6px">🎯 ${esc(q.learning_objective)}</div>` : ''}
      </div>
      <div class="row">
        <button class="small ghost" onclick="editQuestionForm(${id}, ${q.id})">Edit</button>
        <button class="small danger" onclick="deleteQuestion(${id}, ${q.id})">Del</button>
      </div>
    </div>
  </div>`;
}

function schemeHTML(q, id) {
  const scheme = q.scheme || (q.type === 'objective' ? { correct_answer: q.correct_answer, marks: q.marks } : null);
  let summary = '';
  if (q.type === 'objective') {
    summary = `<p><b>Correct answer:</b> ${esc(scheme?.correct_answer || q.correct_answer || '—')} &nbsp; <b>Marks:</b> ${q.marks}</p>`;
  } else if (scheme) {
    summary = `
      <p><b>Model answer:</b> ${esc(scheme.model_answer || '(empty)')}</p>
      <p><b>Key points:</b></p><ul>${(scheme.key_points || []).map((k) => `<li>${esc(k)}</li>`).join('') || '<li>—</li>'}</ul>
      <p><b>Rubric:</b></p>
      <table><thead><tr><th>Point</th><th>Marks</th><th>Explanation</th></tr></thead>
      <tbody>${(scheme.rubric || []).map((r) => `<tr><td>${esc(r.point)}</td><td>${r.marks}</td><td>${esc(r.explanation || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">—</td></tr>'}</tbody></table>
      <p class="muted">Presentation: ${scheme.presentation_marks || 0} · Grammar: ${scheme.grammar_marks || 0}</p>`;
  }
  return `<div class="qitem">
    <div class="qhead">
      <div><div class="muted">Q${q.q_order} · ${q.type}</div><div class="qtext">${esc(q.text)}</div></div>
      <div class="row">
        ${q.type === 'theory' ? `<button class="small ghost" onclick="regenerateScheme(${id}, ${q.id})">✨ AI Regenerate</button>` : ''}
        <button class="small ghost" onclick="editScheme(${id}, ${q.id}, ${q.type === 'theory'})">Edit JSON</button>
      </div>
    </div>
    <div class="scheme">${summary || '<span class="muted">No scheme yet.</span>'}</div>
  </div>`;
}

// ── Question actions ───────────────────────────────────────────────────

function questionFormHTML(q) {
  const type = q?.type || 'objective';
  const opts = (q?.options || [{ key: 'A', text: '' }, { key: 'B', text: '' }, { key: 'C', text: '' }, { key: 'D', text: '' }]);
  return `
    <label>Type</label>
    <div class="row">
      <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="q_type" value="objective" ${type === 'objective' ? 'checked' : ''} onchange="toggleType()"> Objective</label>
      <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="q_type" value="theory" ${type === 'theory' ? 'checked' : ''} onchange="toggleType()"> Theory</label>
    </div>
    <div class="field"><label>Question</label><textarea id="qf_text">${esc(q?.text || '')}</textarea></div>
    <div id="qf_opts">
      ${opts.map((o) => `<div class="row" style="margin:4px 0">
        <input type="text" style="width:40px;text-align:center" value="${esc(o.key)}" disabled>
        <input type="text" data-opt="${esc(o.key)}" value="${esc(o.text)}" placeholder="Option ${esc(o.key)}">
      </div>`).join('')}
      <label>Correct answer</label>
      <div class="row">
        ${['A', 'B', 'C', 'D'].map((k) => `<label style="display:flex;gap:4px;align-items:center"><input type="radio" name="qf_correct" value="${k}" ${q?.correct_answer === k ? 'checked' : ''}> ${k}</label>`).join('')}
      </div>
    </div>
    <div class="field" id="qf_theory_marks"><label>Marks</label><input type="number" id="qf_marks" value="${q?.marks || (type === 'theory' ? 5 : 1)}" step="0.5"></div>
    <div class="field"><label>Difficulty</label>
      <select id="qf_diff">
        ${['easy', 'medium', 'hard'].map((d) => `<option ${q?.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}
      </select></div>
    <div class="field"><label>Learning objective</label><input type="text" id="qf_lo" value="${esc(q?.learning_objective || '')}"></div>
    <div class="field"><label>Explanation (shown after answering)</label><textarea id="qf_expl">${esc(q?.explanation || '')}</textarea></div>`;
}

function toggleType() {
  const theory = document.querySelector('input[name="q_type"]:checked').value === 'theory';
  document.querySelector('#qf_opts').style.display = theory ? 'none' : 'block';
  const m = document.querySelector('#qf_marks');
  if (m && theory && !m.value) m.value = 5;
  if (m && !theory && m.value === '5') m.value = 1;
}

async function addQuestionForm(id) {
  const body = `<div class="field" style="margin:0"><label>Type</label>
    <div class="row">
      <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="q_type" value="objective" checked onchange="toggleType()"> Objective</label>
      <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="q_type" value="theory" onchange="toggleType()"> Theory</label>
    </div></div>
    <div class="field"><label>Question</label><textarea id="qf_text" placeholder="What is the capital of Ghana?"></textarea></div>
    <div id="qf_opts">
      ${['A', 'B', 'C', 'D'].map((k) => `<div class="row" style="margin:4px 0">
        <input type="text" style="width:40px;text-align:center" value="${k}" disabled>
        <input type="text" data-opt="${k}" placeholder="Option ${k}">
      </div>`).join('')}
      <label>Correct answer</label>
      <div class="row">
        ${['A', 'B', 'C', 'D'].map((k) => `<label style="display:flex;gap:4px;align-items:center"><input type="radio" name="qf_correct" value="${k}"> ${k}</label>`).join('')}
      </div>
    </div>
    <div class="field"><label>Marks</label><input type="number" id="qf_marks" value="1" step="0.5"></div>
    <div class="field"><label>Difficulty</label><select id="qf_diff"><option>easy</option><option selected>medium</option><option>hard</option></select></div>
    <div class="row" style="justify-content:flex-end"><button id="qf_save">Add Question</button></div>`;

  const div = await openModal('Add Question', body);
  if (!div) return;
  document.querySelector('#qf_save').addEventListener('click', async () => {
    const type = document.querySelector('input[name="q_type"]:checked').value;
    const payload = {
      type,
      text: document.querySelector('#qf_text').value,
      marks: parseFloat(document.querySelector('#qf_marks').value) || 1,
      difficulty: document.querySelector('#qf_diff').value,
      learning_objective: '',
      explanation: '',
    };
    if (type === 'objective') {
      payload.options = ['A', 'B', 'C', 'D'].map((k) => document.querySelector(`[data-opt="${k}"]`).value.trim());
      const sel = document.querySelector('input[name="qf_correct"]:checked');
      payload.correct_answer = sel ? sel.value : '';
    }
    try {
      await api(`/api/exams/${id}/questions`, { method: 'POST', body: payload });
      div.remove();
      renderExam(id);
    } catch (e) { toast(e.message, true); }
  });
}

async function editQuestionForm(id, qid) {
  const q = examState.data.questions.find((x) => x.id === qid);
  const div = await openModal('Edit Question', questionFormHTML(q));
  if (!div) return;
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Save';
  addBtn.id = 'qf_save';
  div.querySelector('.modal-actions').appendChild(addBtn);
  document.querySelector('#qf_save').addEventListener('click', async () => {
    const type = document.querySelector('input[name="q_type"]:checked').value;
    const payload = {
      type,
      text: document.querySelector('#qf_text').value,
      marks: parseFloat(document.querySelector('#qf_marks').value) || 1,
      difficulty: document.querySelector('#qf_diff').value,
      learning_objective: document.querySelector('#qf_lo').value,
      explanation: document.querySelector('#qf_expl').value,
    };
    if (type === 'objective') {
      payload.options = ['A', 'B', 'C', 'D'].map((k) => document.querySelector(`[data-opt="${k}"]`).value.trim());
      const sel = document.querySelector('input[name="qf_correct"]:checked');
      payload.correct_answer = sel ? sel.value : '';
    }
    try {
      await api(`/api/exams/${id}/questions/${qid}`, { method: 'PUT', body: payload });
      div.remove();
      renderExam(id);
    } catch (e) { toast(e.message, true); }
  });
}

async function deleteQuestion(id, qid) {
  if (!confirm('Delete this question and its marking scheme?')) return;
  await api(`/api/exams/${id}/questions/${qid}`, { method: 'DELETE' });
  renderExam(id);
}

// ── AI generation ──────────────────────────────────────────────────────

async function aiGenerateForm(id) {
  const div = await openModal('Generate Questions with AI', `
    <div class="field"><label>Subject / topic area</label><input type="text" id="ag_subject" placeholder="e.g. Integrated Science — Soil Erosion"></div>
    <div class="field"><label>Number of questions</label><input type="number" id="ag_count" value="10"></div>
    <div class="field"><label>Types</label>
      <div class="row">
        <label style="display:flex;gap:6px"><input type="checkbox" id="ag_obj" checked> Objective</label>
        <label style="display:flex;gap:6px"><input type="checkbox" id="ag_theory" checked> Theory</label>
      </div></div>
    <div class="field"><label>Difficulty</label>
      <select id="ag_diff"><option>easy</option><option selected>medium</option><option>hard</option><option>mixed</option></select></div>
    <div class="field"><label>Extra instructions (optional)</label><textarea id="ag_inst" placeholder="e.g. focus on causes and effects, 12 marks each"></textarea></div>
    <div class="row" style="justify-content:flex-end"><button id="ag_run">Generate</button></div>
  `);
  if (!div) return;
  const run = document.querySelector('#ag_run');
  run.addEventListener('click', async () => {
    run.disabled = true;
    run.textContent = 'Generating…';
    try {
      const types = [];
      if (document.querySelector('#ag_obj').checked) types.push('objective');
      if (document.querySelector('#ag_theory').checked) types.push('theory');
      const body = {
        subject: document.querySelector('#ag_subject').value,
        count: parseInt(document.querySelector('#ag_count').value) || 10,
        types,
        difficulty: document.querySelector('#ag_diff').value,
        instructions: document.querySelector('#ag_inst').value,
      };
      const res = await api(`/api/exams/${id}/generate`, { method: 'POST', body });
      div.remove();
      toast(`Generated ${res.count} questions with full marking schemes.`);
      renderExam(id);
    } catch (e) {
      run.disabled = false;
      run.textContent = 'Generate';
      toast(e.message, true);
    }
  });
}

// ── PDF upload ─────────────────────────────────────────────────────────

async function pdfUploadForm(id) {
  const div = await openModal('Upload Exam PDF', `
    <div class="muted" style="margin-bottom:10px">Text-based PDFs only (scanned images are not supported yet). Answer keys and options are detected automatically; missing answers are generated by AI.</div>
    <input type="file" id="pdf_file" accept="application/pdf">
    <div class="row" style="justify-content:flex-end"><button id="pdf_run">Extract Questions</button></div>
  `);
  if (!div) return;
  document.querySelector('#pdf_run').addEventListener('click', async () => {
    const file = document.querySelector('#pdf_file').files[0];
    if (!file) return toast('Choose a PDF file first.', true);
    const btn = document.querySelector('#pdf_run');
    btn.disabled = true;
    btn.textContent = 'Extracting…';
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`${API_BASE}/api/exams/${id}/pdf`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      div.remove();
      toast(`Extracted ${data.count} questions (schemes generated automatically).`);
      renderExam(id);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Extract Questions';
      toast(e.message, true);
    }
  });
}

// ── Scheme actions ─────────────────────────────────────────────────────

async function editScheme(id, qid, isTheory) {
  const q = examState.data.questions.find((x) => x.id === qid);
  const scheme = q.scheme || {};
  const div = await openModal('Edit Marking Scheme (JSON)', `
    <div class="muted" style="margin-bottom:8px">Edit directly as JSON. For theory: model_answer, key_points, rubric (point/marks/explanation), presentation_marks, grammar_marks.</div>
    <textarea id="sch_json" style="font-family:monospace;min-height:260px">${esc(JSON.stringify(scheme, null, 2))}</textarea>
    <div class="row" style="justify-content:flex-end"><button id="sch_save">Save Scheme</button></div>
  `);
  if (!div) return;
  document.querySelector('#sch_save').addEventListener('click', async () => {
    try {
      const parsed = JSON.parse(document.querySelector('#sch_json').value);
      await api(`/api/exams/${id}/scheme/${qid}`, { method: 'PUT', body: { scheme: parsed } });
      div.remove();
      renderExam(id);
    } catch (e) { toast('Invalid JSON: ' + e.message, true); }
  });
}

async function regenerateScheme(id, qid) {
  try {
    toast('Generating scheme with AI…');
    const res = await api(`/api/exams/${id}/scheme/${qid}/generate`, { method: 'POST' });
    toast('Scheme regenerated.');
    renderExam(id);
  } catch (e) { toast(e.message, true); }
}

// ── Recipients ─────────────────────────────────────────────────────────

async function addRecipients(id) {
  const phones = document.querySelector('#phones_input').value.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
  if (!phones.length) return toast('Enter at least one phone number.', true);
  try {
    const res = await api(`/api/exams/${id}/recipients`, { method: 'POST', body: { phones } });
    toast(`Added ${res.added.length} recipient(s).`);
    renderExam(id);
  } catch (e) { toast(e.message, true); }
}

async function removeRecipient(id, sid) {
  await api(`/api/exams/${id}/recipients/${sid}`, { method: 'DELETE' });
  renderExam(id);
}

async function sendExam(id) {
  if (!confirm('Send this exam to all recipients now? Sessions start immediately.')) return;
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await api(`/api/exams/${id}/send`, { method: 'POST' });
    toast(`Sent to ${res.sent}, failed ${res.failed}.`);
    renderExam(id);
  } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = '📤 Send Exam to Recipients'; }
}

// ── Exam actions ───────────────────────────────────────────────────────

async function publishExam(id) {
  try {
    await api(`/api/exams/${id}/publish`, { method: 'POST' });
    toast('Exam published. Add recipients and send it.');
    renderExam(id);
  } catch (e) { toast(e.message, true); }
}

async function endExam(id) {
  if (!confirm('End this exam? Active sessions will be stopped for new answers.')) return;
  await api(`/api/exams/${id}/end`, { method: 'POST' });
  renderExam(id);
}

async function deleteExam(id) {
  if (!confirm('Permanently delete this exam and all its data?')) return;
  await api(`/api/exams/${id}`, { method: 'DELETE' });
  location.hash = '#/exams';
}

async function editExamMeta(id) {
  const { exam } = examState.data;
  const div = await openModal('Edit Exam', `
    <div class="field"><label>Title</label><input type="text" id="em_title" value="${esc(exam.title)}"></div>
    <div class="field"><label>Subject</label><input type="text" id="em_subject" value="${esc(exam.subject)}"></div>
    <div class="field"><label>Description</label><textarea id="em_desc">${esc(exam.description)}</textarea></div>
    <div class="field"><label>Duration (minutes)</label><input type="number" id="em_dur" value="${exam.duration_minutes}"></div>
    <div class="field"><label>Pass mark (%)</label><input type="number" id="em_pass" value="${exam.pass_percentage}"></div>
    <div class="row" style="justify-content:flex-end"><button id="em_save">Save</button></div>
  `);
  if (!div) return;
  document.querySelector('#em_save').addEventListener('click', async () => {
    const body = {
      title: document.querySelector('#em_title').value,
      subject: document.querySelector('#em_subject').value,
      description: document.querySelector('#em_desc').value,
      duration_minutes: document.querySelector('#em_dur').value,
      pass_percentage: document.querySelector('#em_pass').value,
    };
    await api(`/api/exams/${id}`, { method: 'PATCH', body });
    div.remove();
    renderExam(id);
  });
}

// ── Results ────────────────────────────────────────────────────────────

async function renderResults() {
  const hash = location.hash;
  if (hash.startsWith('#/results/')) {
    const id = hash.split('/')[2];
    return renderResultDetail(id);
  }
  const results = await api('/api/results');
  $view.innerHTML = `
    <h1>Results</h1>
    <p class="muted">Completed and expired sessions</p>
    <div class="card"><table>
      <thead><tr><th>Student</th><th>Exam</th><th>Score</th><th>%</th><th>Result</th><th>Pass Mark</th><th>Ended</th><th></th></tr></thead>
      <tbody>
        ${results.map((s) => `<tr>
          <td>${esc(s.student_name || s.phone)}</td>
          <td>${esc(s.exam_title)}</td>
          <td>${s.final_score}</td>
          <td>${s.final_percentage}%</td>
          <td>${s.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'}</td>
          <td>${s.pass_percentage}%</td>
          <td class="muted">${s.ended_at || '—'}</td>
          <td class="row">
            <a href="${API_BASE}/report/${s.id}" target="_blank"><button class="small">Report</button></a>
            <button class="small ghost" onclick="resendResult(${s.id})">Resend</button>
            <a href="#/results/${s.id}"><button class="small ghost">Details</button></a>
          </td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">No completed sessions yet.</td></tr>'}
      </tbody>
    </table></div>`;
}

async function renderResultDetail(id) {
  const r = await api(`/api/results/${id}`);
  $view.innerHTML = `
    <div class="spread">
      <div>
        <h1>${esc(r.exam.title)} — ${esc(r.exam.subject)}</h1>
        <p class="muted">Score ${r.score}/${r.totalMarks} · ${r.percentage}% · <span class="${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span> (pass ${r.exam.pass_percentage}%)</p>
      </div>
      <div class="row">
        <a href="${API_BASE}/report/${id}" target="_blank"><button>Open Report</button></a>
        <button class="ghost" onclick="resendResult(${id})">Resend Result</button>
        <a href="#/results"><button class="ghost">Back</button></a>
      </div>
    </div>
    <div class="card"><table>
      <thead><tr><th>#</th><th>Question</th><th>Student Answer</th><th>Key</th><th>Marks</th><th>Marked By</th><th>Feedback</th><th></th></tr></thead>
      <tbody>
        ${r.answers.map((a) => `<tr>
          <td>${a.q_order}</td>
          <td style="max-width:280px">${esc(a.text)}</td>
          <td>${esc(a.answer_text)}</td>
          <td>${a.type === 'objective' ? esc(a.correct_answer) : '—'}</td>
          <td><input type="number" data-aw="${a.id}" value="${a.marks_awarded}" step="0.5" style="width:70px"> / ${a.max_marks}</td>
          <td>${a.marked_by}${a.needs_review ? ' <span class="badge review">review</span>' : ''}</td>
          <td style="max-width:280px">${esc(a.ai_feedback)}</td>
          <td><button class="small" onclick="saveMarks(${id}, ${a.id})">Save</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

async function saveMarks(sessionId, answerId) {
  const input = document.querySelector(`[data-aw="${answerId}"]`);
  await api(`/api/results/${sessionId}/answers/${answerId}`, {
    method: 'PATCH',
    body: { marks_awarded: parseFloat(input.value), reviewed: true },
  });
  toast('Marks saved.');
  renderResultDetail(sessionId);
}

async function resendResult(id) {
  try {
    await api(`/api/results/${id}/resend`, { method: 'POST' });
    toast('Result sent via WhatsApp.');
  } catch (e) { toast(e.message, true); }
}

// ── Students ───────────────────────────────────────────────────────────

async function renderStudents() {
  const students = await api('/api/students');
  $view.innerHTML = `
    <h1>Students</h1>
    <p class="muted">Everyone who has interacted with the exam bot</p>
    <div class="card"><table>
      <thead><tr><th>Name</th><th>Phone</th><th>Exams</th><th>Attempts</th><th>First seen</th><th></th></tr></thead>
      <tbody>
        ${students.map((s) => `<tr>
          <td>${esc(s.name || '—')}</td>
          <td>${esc(s.phone)}</td>
          <td>${s.exams}</td>
          <td>${s.attempts}</td>
          <td class="muted">${s.created_at}</td>
          <td><button class="small ghost" onclick="renameStudent(${s.id})">Rename</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

async function renameStudent(id) {
  const name = prompt('Student name:');
  if (name == null) return;
  await api(`/api/students/${id}`, { method: 'PATCH', body: { name } });
  renderStudents();
}

// ── Boot ───────────────────────────────────────────────────────────────

router();
