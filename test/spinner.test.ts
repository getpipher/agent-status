import { test } from "node:test";
import assert from "node:assert/strict";
import { frameAt, createSpinner, FRAMES } from "../lib/spinner.ts";

test("frameAt cycles through the 10 braille frames", () => {
  for (let i = 0; i < FRAMES.length; i++) assert.equal(frameAt(i), FRAMES[i]);
  assert.equal(frameAt(FRAMES.length), FRAMES[0]);
  assert.equal(frameAt(13), FRAMES[3]);
});

test("advance() returns sequential frames and increments", () => {
  const spinner = createSpinner();
  assert.equal(spinner.advance(), FRAMES[0]);
  assert.equal(spinner.advance(), FRAMES[1]);
  assert.equal(spinner.advance(), FRAMES[2]);
});

test("advance() wraps after FRAMES.length", () => {
  const spinner = createSpinner();
  for (let i = 0; i < FRAMES.length; i++) spinner.advance();
  assert.equal(spinner.advance(), FRAMES[0]); // wrapped
});

test("reset() returns the index to 0", () => {
  const spinner = createSpinner();
  spinner.advance(); spinner.advance();
  spinner.reset();
  assert.equal(spinner.advance(), FRAMES[0]);
});

test("current() returns the next frame without advancing", () => {
  const spinner = createSpinner();
  assert.equal(spinner.current(), FRAMES[0]);
  spinner.advance();
  assert.equal(spinner.current(), FRAMES[1]);
});