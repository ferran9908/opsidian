/** Puts text on the clipboard without asking for the clipboard permission, which is refused. */
export function copyText(text: string): Promise<void> {
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  return copied ? Promise.resolve() : Promise.reject(new Error('Could not copy.'));
}
