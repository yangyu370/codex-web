import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetchGlobals = Object.fromEntries(
  [
    "fetch",
    "Headers",
    "Request",
    "Response",
    "ReadableStream",
    "WritableStream",
    "TransformStream",
    "TextDecoder",
    "TextEncoder",
  ].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
GlobalRegistrator.register();
for (const [name, descriptor] of Object.entries(nativeFetchGlobals)) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
}
