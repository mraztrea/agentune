import path from 'path';

export function resolveStaticFilePath(publicDir: string, pathname: string): string | null {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const normalizedPathname = decodedPathname.replace(/^[\\/]+/, '');
  const resolvedPath = path.resolve(publicDir, normalizedPathname);
  const relativePath = path.relative(publicDir, resolvedPath);
  if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
    return resolvedPath;
  }

  return null;
}
