/**
 * Untrusted-content handling. Text from imported documents is DATA: it is
 * shown to agents/LLMs inside explicit untrusted blocks, never concatenated
 * into instructions, and nothing in it can change workflow state — status
 * transitions, approvals and permissions are decided by code + human
 * decisions only. This scanner just makes instruction-like content visible.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/ignore (all |any )?(previous|prior|above) (instructions|rules)/i, "yêu cầu bỏ qua hướng dẫn"],
  [/disregard (the )?(system|previous)/i, "yêu cầu bỏ qua hệ thống"],
  [/\b(system|assistant)\s*:/i, "giả dạng vai trò hệ thống"],
  [/you are now|act as (an? )?(admin|approver)/i, "đổi vai trò"],
  [/(approve|authori[sz]e)[^.\n]{0,40}(immediately|now|without)/i, "yêu cầu phê duyệt ngay"],
  [/(send|issue|release)[^.\n]{0,30}(purchase order|\bPO\b|payment)/i, "yêu cầu phát hành đơn hàng/thanh toán"],
  [/bỏ qua (mọi |các )?(hướng dẫn|chỉ dẫn|quy trình)/i, "yêu cầu bỏ qua hướng dẫn"],
  [/phê duyệt (ngay|luôn|không cần)/i, "yêu cầu phê duyệt ngay"],
  [/(cấp|nâng) quyền|quyền quản trị/i, "yêu cầu thay đổi quyền"],
];

export function scanUntrusted(text: string): string[] {
  const flags = new Set<string>();
  for (const [re, label] of PATTERNS) if (re.test(text)) flags.add(label);
  return [...flags];
}

/** Wrap document text for an LLM prompt as inert, delimited data. */
export function asUntrustedBlock(id: string | number, title: string, text: string, maxChars = 4000): string {
  const clipped = text.length > maxChars ? text.slice(0, maxChars) + "\n…[cắt bớt]" : text;
  // Neutralize any attempt to close the block early
  const safe = clipped.replace(/<\/?untrusted_document/gi, "‹untrusted_document");
  return `<untrusted_document id="${id}" title="${title.replace(/"/g, "'")}">\n${safe}\n</untrusted_document>`;
}
