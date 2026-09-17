/// <reference types="vite/client" />
declare module '*?raw' {
  const src: string;
  export default src;
}
declare module '*?worker&inline' {
  const WorkerCtor: { new (): Worker };
  export default WorkerCtor;
}
