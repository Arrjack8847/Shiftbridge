import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIncomingMessage as classify } from './message-intent.js';

test('clear equipment faults open reported issues without waiting for AI', () => {
  for (const body of [
    'The coffee machine is broken',
    'Something is broken',
    'Printer is not working',
    'Machine 2 is leaking again.',
    'The POS is offline',
    'The fridge stopped working',
  ]) {
    const result = classify(body);
    assert.equal(result.route, 'issue', body);
    assert.equal(result.issueType, 'equipment', body);
  }
});

test('dangerous incident reports are high severity but not verified', () => {
  for (const body of ['There is smoke near the machine', 'Gas leak in the kitchen',
    'The wire is sparking', 'That is unsafe']) {
    const result = classify(body);
    assert.equal(result.route, 'issue', body);
    assert.equal(result.issueType, 'safety', body);
    assert.equal(result.severity, 'high', body);
  }
});

test('stockouts are warnings', () => {
  assert.equal(classify('We are out of stock on cups').issueType, 'inventory');
});

test('greetings skip unnecessary CodeBuddy invocation', () => {
  for (const body of ['Hi', 'thanks!', 'OK', 'got it', '👍']) {
    assert.equal(classify(body).route, 'skip', body);
  }
});

test('questions, hypothetical, negated, resolved, and personal phrases are not instant issues', () => {
  for (const body of [
    'Is the printer broken?',
    'What if the machine is broken?',
    'If the fridge stops working, call me',
    'The machine is not broken',
    'Nothing is broken',
    'The printer was fixed',
    'Printer is working again',
    'My broken heart',
    'The machine is making a weird noise',
  ]) assert.notEqual(classify(body).route, 'issue', body);
});

test('combined warnings and instructions still receive AI task review', () => {
  const r = classify('Machine 2 is broken. Please ask Emma to fix it.');
  assert.equal(r.route, 'issue');
  assert.equal(r.needsAi, true);
});


test('explicit routine manager-style tasks can avoid CodeBuddy on validated backend', () => {
  const result = classify('Emma, please restock the paper cups before 5 PM.');
  assert.equal(result.route, 'routine-task');
  assert.deepEqual(result.task, {
    assignee: 'emma',
    name: 'Restock the paper cups',
    due: 'Before 5 PM',
    category: 'inventory',
    priority: 'normal',
  });
  assert.equal(classify('Jack please clean the tables').task.category, 'cleaning');
});

test('never fast-path repairs, spending, conditionals or multi-part task plans', () => {
  for (const body of [
    'Emma please repair the printer',
    'Emma please purchase new cups',
    'Emma clean the machine if the lights are on',
    'Emma please clean the tables and repair the oven',
    'Emma clean the electrical panel',
  ]) assert.notEqual(classify(body).route, 'routine-task', body);
});

test('common informal fault phrases are recognized', () => {
  for (const body of [
    "The printer isn't working",
    'The aircon is spoilt',
    'Machine rosak',
  ]) assert.equal(classify(body).route, 'issue', body);
});

