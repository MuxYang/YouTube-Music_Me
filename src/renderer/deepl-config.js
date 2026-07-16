'use strict';

const text = window.deeplConfig.strings;
const form = document.getElementById('form');
const input = document.getElementById('key');
const error = document.getElementById('error');
const cancel = document.getElementById('cancel');
const save = document.getElementById('save');

document.documentElement.lang = text.languageTag;
document.title = `${text.title} - YouTube Music Me`;
document.getElementById('title').textContent = text.title;
document.getElementById('description').textContent = text.description;
document.getElementById('key-label').textContent = text.keyLabel;
input.placeholder = text.keyLabel;
error.textContent = text.error;
cancel.textContent = text.cancel;
save.textContent = text.save;

cancel.addEventListener('click', () => window.deeplConfig.close());
input.addEventListener('input', () => {
  error.hidden = true;
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const authKey = input.value.trim();
  if (!authKey) {
    error.hidden = false;
    input.focus();
    return;
  }
  input.disabled = true;
  cancel.disabled = true;
  save.disabled = true;
  save.textContent = text.saving;
  error.hidden = true;
  try {
    await window.deeplConfig.save(authKey);
    input.value = '';
    window.deeplConfig.close();
  } catch {
    input.disabled = false;
    cancel.disabled = false;
    save.disabled = false;
    save.textContent = text.save;
    error.hidden = false;
    input.focus();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.deeplConfig.close();
  }
});

input.focus();
