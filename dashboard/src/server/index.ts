// O emit fica em dist/server, na mesma profundidade de src/server. O specifier aponta
// para o CJS já compilado de graph-scripts: o tsc não reescreve o caminho do project reference.
export { resolvePlatformAsset, resolvePlatformRoots } from "../../../scripts/dist/index.js";
export type { PlatformRoots, ResolveRootsOptions } from "../../../scripts/dist/index.js";
