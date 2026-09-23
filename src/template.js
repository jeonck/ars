// Pure SMS-template rendering (no side effects), shared by the server app
// and the GitHub-native (Actions) processing scripts.
// Supported placeholders: {business}, {link}, {caller}.
export function renderTemplate(template, vars) {
  return template.replace(/\{(business|link|caller)\}/g, (_, k) => vars[k] ?? '');
}
