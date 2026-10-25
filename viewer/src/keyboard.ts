/** True while the user types in a text field: game keys must not act then. */
export function isTyping(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null
  if (!target || typeof target.tagName !== 'string') return false
  return target.tagName === 'TEXTAREA' || target.isContentEditable || (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text')
}
