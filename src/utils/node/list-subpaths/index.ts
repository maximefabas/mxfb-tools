import { Stats, promises as fs } from 'node:fs'
import path from 'node:path'
import { stringMatchesSome } from '~/utils/agnostic/string-matches'

export type ChildType = 'file' | 'directory' | 'symlink'

export type ChildDetails = {
  type: ChildType
  hidden: boolean
  realPath: string
}

export type Options = {
  directories?: boolean
  files?: boolean
  symlinks?: boolean
  hidden?: boolean
  followSimlinks?: boolean
  dedupeSimlinksContents?: boolean
  maxDepth?: number
  returnRelative?: boolean
  exclude?: RegExp | string | (RegExp | string)[] | null
  include?: RegExp | string | (RegExp | string)[] | null
  filter?: ((path: string, details: ChildDetails) => boolean | Promise<boolean>)
}

export const defaultOptions: Required<Options> = {
  directories: true,
  files: true,
  symlinks: true,
  hidden: true,
  followSimlinks: false,
  dedupeSimlinksContents: false,
  maxDepth: Infinity,
  returnRelative: false,
  exclude: null,
  include: null,
  filter: () => true
}

export const fillOptions = (input: Options): Required<Options> => {
  return {
    ...defaultOptions,
    ...input
  }
}

export type Context = {
  depth?: number
  lstats?: Stats | null
  rootPath?: string | null
}

export const defaultContext: Required<Context> = {
  depth: 0,
  lstats: null,
  rootPath: null
}

export const fillContext = (input: Context): Required<Context> => {
  return {
    ...defaultContext,
    ...input
  }
}

export default async function listSubpaths (...args: Parameters<typeof listAbsoluteSubpaths>) {
  const [inputPath, _options] = args
  const options = fillOptions(_options ?? {})
  const subpaths = await listAbsoluteSubpaths(...args)
  return options.returnRelative
    ? subpaths.map(subpath => path.relative(inputPath, subpath))
    : subpaths
}

async function listAbsoluteSubpaths (
  inputPath: string,
  _options: Options = {},
  __private_context: Context = {}
): Promise<string[]> {
  const options = fillOptions(_options)
  const _private_context = fillContext(__private_context)
  if (_private_context.rootPath === null) { _private_context.rootPath = inputPath }
  const subpaths: string[] = []
  if (_private_context.depth > options.maxDepth) return subpaths
  try {
    const pathStat = _private_context.lstats ?? await fs.lstat(inputPath)
    if (!pathStat.isDirectory()) return subpaths
  } catch (err) {
    return subpaths
  }
  const childrenRelPaths = await fs.readdir(inputPath)
  await Promise.all(childrenRelPaths.map(async childRelPath => {
    const childAbsPath = path.join(inputPath, childRelPath)
    const childRelFromRootPath = path.relative(_private_context.rootPath ?? inputPath, childAbsPath)
    const childLstats = await fs.lstat(childAbsPath)
    try {
      const isDirectory = childLstats.isDirectory()
      const isSymlink = childLstats.isSymbolicLink()
      const isFile = !isDirectory && !isSymlink
      const isHidden = path.basename(childAbsPath).startsWith('.')
      const type = isDirectory ? 'directory' : (isSymlink ? 'symlink' : 'file')
      if (isDirectory && options.directories === false) throw true
      if (isSymlink && options.symlinks === false) throw false
      if (isFile && options.files === false) throw false
      if (isHidden && options.hidden === false) throw false
      const realPath = isSymlink
        ? await fs.realpath(childAbsPath)
        : childAbsPath
      const childPathForFilters = options.returnRelative ? childRelFromRootPath : childAbsPath
      const isInExclude = stringMatchesSome(childPathForFilters, options.exclude ?? [])
      const isInInclude = stringMatchesSome(childPathForFilters, options.include ?? [])
      if (isInExclude && !isInInclude) throw false
      const isInFilter = await options.filter(childPathForFilters, { type, hidden: isHidden, realPath })
      if (!isInFilter) throw true
      if (isSymlink) {
        if (options.followSimlinks === false) subpaths.push(childAbsPath)
        else {
          const childSubpaths = await listAbsoluteSubpaths(realPath, options, {
            ..._private_context,
            depth: _private_context.depth + 1
          })
          subpaths.push(realPath, ...childSubpaths)
        }
      } else {
        if (isDirectory) {
          const childSubpaths = await listAbsoluteSubpaths(childAbsPath, options, {
            ..._private_context,
            depth: _private_context.depth + 1,
            lstats: childLstats
          })
          subpaths.push(childAbsPath, ...childSubpaths)
        } else {
          subpaths.push(childAbsPath)
        }
      }
    } catch (err: unknown) {
      if (typeof err !== 'boolean') throw new Error(`This try/catch block should only throw booleans`)
      const shouldDiveDeeper = err
      if (!shouldDiveDeeper) return []
      const childSubpaths = await listAbsoluteSubpaths(childAbsPath, options, {
        ..._private_context,
        depth: _private_context.depth + 1,
        lstats: childLstats
      })
      subpaths.push(...childSubpaths)
    }
  }))
  
  return options.dedupeSimlinksContents
    ? Array.from(new Set(subpaths))
    : subpaths
}
