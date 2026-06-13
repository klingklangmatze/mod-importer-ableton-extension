declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.js" {
  const factory: (opts?: object) => Promise<any>;
  export default factory;
}
