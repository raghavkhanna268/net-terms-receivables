/// <reference types="vite/client" />

declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare module "react-dom/server.browser" {
  export { renderToReadableStream } from "react-dom/server";
}
