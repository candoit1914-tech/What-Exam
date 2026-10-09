'use strict';
require('./helpers/isolate');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stripPaperFurniture } = require('../src/services/textClean');
const exam = require('../src/services/exam');
const selection = require('../src/services/selection');

// One page of a real French mock, front matter and all: the running header,
// the paper's own title, its time and marks lines, the printed INSTRUCTIONS
// block, the PART label with its description, the per-question label — and
// under all of it the reading text a comprehension question needs.
const frenchPage = [
  '2027 BECE French Mock | Original practice material Page 8',
  'PAPER 2: WRITTEN AND COMMUNICATIVE SKILLS',
  'Time: 1 hour 25 minutes Suggested raw marks: 100',
  'INSTRUCTIONS: Answer all questions in Part 1.',
  'In Part 2, answer any THREE questions.',
  'Write clearly in French where instructed.',
  'Marks reward accuracy, relevant content and clear communication.',
  'PART 1: COMPULSORY READING AND LANGUAGE TASK',
  'Question 1 [40 marks]',
  'Texte : La journée de Kofi',
  "Je m'appelle Kofi Mensah.",
  "J'ai treize ans et j'habite à Kumasi avec mes parents et ma petite sœur.",
  'Je veux devenir médecin pour aider les personnes malades.',
].join('\n');

// Nothing of the paper's front matter may reach a student. The reading text
// below is what the questions are answered FROM — it is content, not furniture.
const NOT_FOR_THE_STUDENT = [
  /Original practice material/,
  /Page 8/,
  /PAPER 2/,
  /WRITTEN AND COMMUNICATIVE SKILLS/,
  /Time:/,
  /Suggested raw marks/,
  /INSTRUCTIONS/,
  /Answer all questions in Part 1/,
  /answer any THREE questions/,
  /Write clearly in French/,
  /Marks reward accuracy/,
  /Question 1 \[40 marks\]/,
  /COMPULSORY READING AND LANGUAGE TASK/,
];

function assertNoFurniture(text, where) {
  for (const re of NOT_FOR_THE_STUDENT) {
    assert.doesNotMatch(text, re, `${where} still carries the paper's front matter: ${re}`);
  }
}

test('the paper front matter is stripped and the reading text is kept', () => {
  const out = stripPaperFurniture(frenchPage);

  assertNoFurniture(out, 'stripPaperFurniture');

  // The PART label survives as the label alone — structure without prose.
  assert.match(out, /^PART 1$/m, 'the part label is shortened to its label');
  // The passage a comprehension question is answered from survives whole.
  assert.match(out, /^Texte : La journée de Kofi$/m, 'the passage title stays');
  assert.match(out, /Je m'appelle Kofi Mensah\./);
  assert.match(out, /Je veux devenir médecin pour aider les personnes malades\./);
});

test('a question stem that merely reads like an instruction is never dropped', () => {
  const stems = [
    'Write a letter to your friend thanking him for the birthday gift he sent you.',
    'Read the passage and answer the question that follows.',
    'Answer the following questions in not more than 150 words each.',
    'Part 1 of the story ends with Kofi leaving the village.',
    'Question 1 asks you to evaluate Kofi\'s decision.',
  ];
  for (const stem of stems) {
    assert.equal(stripPaperFurniture(stem), stem, `a real question was rewritten: ${stem}`);
  }
});

test('the chat gets the questions and the reading text, not the front matter', () => {
  const q1 = { id: 1, q_order: 1, type: 'theory', text: 'Quel âge a Kofi ?', passage: frenchPage };
  const q2 = { id: 2, q_order: 2, type: 'theory', text: 'Où habite Kofi ?', passage: '' };

  const bubbles = exam.buildQuestionBubbles({}, q1, [q1, q2], 0);
  const chat = bubbles.join('\n');

  assertNoFurniture(chat, 'the question bubbles');
  assert.match(chat, /^\*PART 1\*$/m, 'the app prints its own simple part label');
  assert.match(chat, /Je m'appelle Kofi Mensah\./, 'the passage still reaches the student');
  assert.ok(
    bubbles.some((b) => b.includes('Quel âge a Kofi ?')),
    'the question itself is sent'
  );
});

test('the invite says how to open the exam by hand if the questions do not come', () => {
  const paper = {
    id: 999991,
    title: 'Test',
    subject: 'French',
    duration_minutes: 10,
    pass_percentage: 50,
    pricing: 'free',
  };
  const hint = /type Hi or Exam in this chat and your exam will start immediately/;

  const invite = exam.formatExamIntro(paper, 45);
  assert.match(invite, hint, 'the invite carries the fallback');
  assert.match(invite, /Reply \*START\*/, 'and still opens with the START prompt');

  const opening = exam.formatExamIntro(paper, 45, { opening: true });
  assert.match(opening, hint, 'the block sent ahead of question 1 carries it too');
  assert.doesNotMatch(opening, /Reply \*START\*/, 'question 1 is already on its way');

  const started = exam.formatExamIntro(paper, 45, { started: true });
  assert.doesNotMatch(started, hint, 'a paper already running needs no start hint');
});

test('a section the student reads is labelled simply', () => {
  assert.equal(
    selection.sectionLabel({ title: 'PART 1: COMPULSORY READING AND LANGUAGE TASK' }),
    'PART 1'
  );
  assert.equal(selection.sectionLabel({ title: 'PART A, LEXIS AND STRUCTURE' }), 'PART A');
  assert.equal(selection.sectionLabel({ title: 'SECTION B' }), 'SECTION B');
  assert.equal(selection.sectionLabel({ title: '' }), '');
  assert.equal(selection.sectionLabel(null), '');
});
