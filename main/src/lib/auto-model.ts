// Auto: a menu model that is not a model. It sends the request to GLM 5.3 Flash and shows that model's
// details (thinking and context window), so the picker can start on it instead of having no model chosen.
// The client sends the target id; the server resolves Auto too, so every entry point routes the same way.

export const AUTO_MODEL_ID = 'auto'
export const AUTO_MODEL_NAME = 'Auto'
export const AUTO_TARGET_ID = '@cf/zai-org/glm-5.3-flash'

/** The model id a request really uses: Auto becomes its target, every other id is returned unchanged. */
export function resolveAutoModel(id: string | undefined): string | undefined {
  return id === AUTO_MODEL_ID ? AUTO_TARGET_ID : id
}
