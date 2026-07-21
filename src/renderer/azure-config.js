'use strict';

const text = window.azureConfig.strings;
const form = document.getElementById('form');
const keyInput = document.getElementById('key');
const regionInput = document.getElementById('region');
const endpointInput = document.getElementById('endpoint');
const error = document.getElementById('error');
const cancel = document.getElementById('cancel');
const save = document.getElementById('save');
const inputs = [keyInput, regionInput, endpointInput];

document.documentElement.lang = text.languageTag;
document.title = `${text.title} - YouTube Music Me`;
document.getElementById('title').textContent = text.title;
document.getElementById('description').textContent = text.description;
document.getElementById('key-label').textContent = text.keyLabel;
document.getElementById('region-label').textContent = text.regionLabel;
document.getElementById('endpoint-label').textContent = text.endpointLabel;
keyInput.placeholder = text.keyLabel;
regionInput.placeholder = text.regionLabel;
endpointInput.placeholder = text.endpointPlaceholder;
endpointInput.value = text.endpointPlaceholder;
error.textContent = text.error;
cancel.textContent = text.cancel;
save.textContent = text.save;

cancel.addEventListener('click', () => window.azureConfig.close());
for (const input of inputs) {
  input.addEventListener('input', () => {
    error.hidden = true;
  });
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) {
    error.hidden = false;
    keyInput.focus();
    return;
  }
  for (const input of inputs) input.disabled = true;
  cancel.disabled = true;
  save.disabled = true;
  save.textContent = text.saving;
  error.hidden = true;
  try {
    await window.azureConfig.save({
      endpoint: endpointInput.value.trim(),
      key,
      region: regionInput.value.trim()
    });
    keyInput.value = '';
    window.azureConfig.close();
  } catch {
    for (const input of inputs) input.disabled = false;
    cancel.disabled = false;
    save.disabled = false;
    save.textContent = text.save;
    error.hidden = false;
    keyInput.focus();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.azureConfig.close();
  }
});

keyInput.focus();
