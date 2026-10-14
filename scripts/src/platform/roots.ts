import fs from "node:fs";
import path from "node:path";

// Marcadores de pacote, não de git: a cópia isolada sem .git continua sendo a plataforma.
const PLATFORM_PACKAGES = [
    ["scripts", "graph-scripts"],
    ["dashboard", "graph-dashboard"],
] as const;

export interface RootEnv {
    PRISMA_ROOT?: string;
    REPO_PATH?: string;
}

export interface ResolveRootsOptions {
    env?: RootEnv;
    // Diretório de partida da busca. No dist compilado, __dirname não é a raiz.
    moduleDir?: string;
    consumerRoot?: string;
}

export interface PlatformRoots {
    platformRoot: string;
    consumerRoot: string;
}

function envValue(env: RootEnv, key: keyof RootEnv): string | undefined {
    const value = env[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function readPackageName(file: string): string | null {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) return null;
        const name = parsed.name;
        return typeof name === "string" ? name : null;
    } catch {
        return null;
    }
}

function isPlatformRoot(dir: string): boolean {
    return PLATFORM_PACKAGES.every(([pkg, name]) => {
        return readPackageName(path.join(dir, pkg, "package.json")) === name;
    });
}

function resolveExistingDir(input: string, label: string): string {
    if (!path.isAbsolute(input)) throw new Error(`${label} deve ser absoluto`);
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`${label} não é um diretório: ${resolved}`);
    }
    return fs.realpathSync(resolved);
}

function walkPlatformRoot(start: string): string | null {
    let current = resolveExistingDir(start, "moduleDir");
    for (;;) {
        if (isPlatformRoot(current)) return current;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

export function resolvePlatformRoots(options: ResolveRootsOptions = {}): PlatformRoots {
    const env = options.env ?? process.env;
    const moduleDir = options.moduleDir ?? __dirname;
    const fromEnv = envValue(env, "PRISMA_ROOT");
    const platformRoot = fromEnv
        ? resolveExistingDir(fromEnv, "PRISMA_ROOT")
        : walkPlatformRoot(moduleDir);
    if (!platformRoot || !isPlatformRoot(platformRoot)) {
        throw new Error("PRISMA_ROOT não é a raiz da plataforma (graph-scripts e graph-dashboard); a busca não usa .git");
    }

    const consumerInput = options.consumerRoot ?? envValue(env, "REPO_PATH");
    if (!consumerInput) {
        throw new Error("REPO_PATH ou consumerRoot é obrigatório; a raiz do consumidor não é inferida da plataforma");
    }
    const consumerRoot = resolveExistingDir(consumerInput, "REPO_PATH");
    return { platformRoot, consumerRoot };
}

export function resolvePlatformAsset(roots: PlatformRoots, ...segments: string[]): string {
    if (segments.length === 0) throw new Error("asset relativo obrigatório");
    for (const segment of segments) {
        if (typeof segment !== "string" || segment.length === 0 || path.isAbsolute(segment)) {
            throw new Error("asset da plataforma deve ser relativo");
        }
        if (segment.split(/[\\/]/).includes("..")) throw new Error("asset da plataforma não aceita ..");
    }
    const asset = path.resolve(roots.platformRoot, ...segments);
    const relative = path.relative(roots.platformRoot, asset);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("asset fora da raiz da plataforma");
    }
    return asset;
}
