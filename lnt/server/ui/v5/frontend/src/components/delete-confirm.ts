// components/delete-confirm.ts — Reusable delete-with-confirmation UI pattern.

import { el } from '../utils';
import { authErrorMessage } from '../api';

export interface DeleteConfirmOptions {
  /** Label for the initial delete button (e.g. "Delete Machine"). */
  label: string;
  /** Prompt text shown in the confirmation area. */
  prompt: string;
  /** The value the user must type to enable the confirm button. */
  confirmValue: string;
  /** Placeholder text for the confirmation input. */
  placeholder?: string;
  /** Optional message shown while the deletion is in progress. */
  deletingMessage?: string;
  /** Async function that performs the actual deletion. */
  onDelete: () => Promise<void>;
  /** Called after successful deletion (e.g. to navigate away). */
  onSuccess: () => void;
}

/**
 * Render a delete button with a type-to-confirm safeguard.
 *
 * Clicking the button reveals a confirmation area where the user must type
 * a specific value before the confirm button becomes enabled.
 */
export function renderDeleteConfirm(
  container: HTMLElement,
  options: DeleteConfirmOptions,
): void {
  const deleteBtn = el('button', { class: 'admin-btn admin-btn-danger' }, options.label);

  const confirmDiv = el('div', { class: 'delete-machine-confirm' });
  confirmDiv.style.display = 'none';

  const errorDiv = el('div', {});

  deleteBtn.addEventListener('click', () => {
    deleteBtn.style.display = 'none';
    confirmDiv.style.display = '';
  });

  const prompt = el('p', {}, options.prompt);
  const confirmInput = el('input', {
    type: 'text',
    class: 'admin-input',
    placeholder: options.placeholder ?? '',
  }) as HTMLInputElement;
  const confirmBtn = el('button', { class: 'admin-btn admin-btn-danger', disabled: '' }, 'Confirm Delete') as HTMLButtonElement;
  const cancelBtn = el('button', { class: 'admin-btn' }, 'Cancel');

  confirmInput.addEventListener('input', () => {
    confirmBtn.disabled = confirmInput.value !== options.confirmValue;
  });

  cancelBtn.addEventListener('click', () => {
    confirmDiv.style.display = 'none';
    confirmInput.value = '';
    confirmBtn.disabled = true;
    deleteBtn.style.display = '';
    errorDiv.replaceChildren();
  });

  confirmBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting...';
    if (options.deletingMessage) {
      errorDiv.replaceChildren(
        el('p', { class: 'progress-label' }, options.deletingMessage),
      );
    } else {
      errorDiv.replaceChildren();
    }

    options.onDelete()
      .then(() => {
        options.onSuccess();
      })
      .catch((err: unknown) => {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm Delete';
        errorDiv.replaceChildren(el('p', { class: 'error-banner' }, authErrorMessage(err)));
      });
  });

  const btnRow = el('div', { class: 'admin-form-row' }, confirmBtn, cancelBtn);
  confirmDiv.append(prompt, confirmInput, btnRow);
  container.append(deleteBtn, confirmDiv, errorDiv);
}
