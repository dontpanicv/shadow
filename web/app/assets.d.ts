/** A file that the web build copies with a hash in its name; the import is its URL. */
declare module "*.svg" {
  const url: string;
  export default url;
}
