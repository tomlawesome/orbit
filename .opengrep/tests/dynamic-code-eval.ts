export function bad(src: string): unknown {
  // ruleid: dynamic-code-eval
  const a = eval(src);
  // ruleid: dynamic-code-eval
  const f = new Function("x", src);
  // ruleid: dynamic-code-eval
  setTimeout("tick()", 10);
  return [a, f];
}

export function good(n: number): unknown {
  // ok: dynamic-code-eval
  setTimeout(() => n + 1, 10);
  // ok: dynamic-code-eval
  return JSON.parse("{}");
}
