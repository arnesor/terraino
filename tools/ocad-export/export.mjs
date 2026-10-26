#!/usr/bin/env node
// Export an OCAD map to files the Terrain-O pipeline can read:
//
//   meta.json        CRS, scale, map bounds, world extent and symbol table
//   objects.geojson  map objects in projected coordinates (no symbol graphics)
//   map.svg          rendered map in projected metres (y down), viewBox = world extent
//   map.png          map.svg rasterised to the world extent (overlay in the viewer)
//   drape.png        only kept terrain symbols (no text, north lines, frame or legend)
//
// Usage: node export.mjs <map.ocd> <out-dir> [options]
//   --extent x0,y0,x1,y1   world extent in projected metres (default: map bounds + margin)
//   --margin 300           margin around the map bounds when --extent is not given
//   --align 16             snap the default extent outward to this many metres
//   --offset dx,dy         shift the map by this many metres (fixes georeferencing errors)
//   --keep ids.json        JSON list of object ids to use for drape.png (default: all terrain)
//   --map-px-per-m 1       resolution of map.png
//   --drape-px-per-m 2     resolution of drape.png
//   --no-png               skip map.png and drape.png
//
// Object ids are the 0-based index among the visible objects, as written in
// objects.geojson ("oid"). They are stable between runs on the same file.
//
// This tool is licensed AGPL-3.0, because it links ocad2geojson (AGPL-3.0).
// The terraino Python package only runs it as a separate program.

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import ocad2geojson from 'ocad2geojson'
import xmldom from '@xmldom/xmldom'
import { Resvg } from '@resvg/resvg-js'

const { readOcad, ocadToGeoJson, ocadToSvg } = ocad2geojson
const { DOMImplementation, XMLSerializer } = xmldom

// OCAD paper units are 1/100 mm.
const PAPER_UNITS_PER_M = 100 * 1000

// Symbols numbered from 600 up are map furniture (north lines, frame, texts, legend).
const FIRST_NON_TERRAIN_SYMBOL = 600
const TEXT_SYMBOL_TYPE = 4

function usage(message) {
  if (message) console.error(message)
  console.error('Usage: node export.mjs <map.ocd> <out-dir> [options] (see the header of export.mjs)')
  process.exit(2)
}

function parseNumbers(text, count, name) {
  const values = text.split(',').map(Number)
  if (values.length !== count || !values.every(Number.isFinite)) {
    usage(`${name} must be ${count} comma-separated numbers`)
  }
  return values
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    extent: { type: 'string' },
    margin: { type: 'string', default: '300' },
    align: { type: 'string', default: '16' },
    offset: { type: 'string', default: '0,0' },
    keep: { type: 'string' },
    'map-px-per-m': { type: 'string', default: '1' },
    'drape-px-per-m': { type: 'string', default: '2' },
    'no-png': { type: 'boolean', default: false },
  },
})
if (positionals.length !== 2) usage()
const [mapPath, outDir] = positionals
const margin = Number(opts.margin)
const align = Number(opts.align)
const mapPxPerM = Number(opts['map-px-per-m'])
const drapePxPerM = Number(opts['drape-px-per-m'])
const [offsetX, offsetY] = parseNumbers(opts.offset, 2, '--offset')
const fixedExtent = opts.extent ? parseNumbers(opts.extent, 4, '--extent') : null
if (
  ![margin, align, mapPxPerM, drapePxPerM].every(Number.isFinite) ||
  align <= 0 ||
  mapPxPerM <= 0 ||
  drapePxPerM <= 0
) {
  usage('--margin, --align and the px-per-m options must be numbers, and align/px-per-m > 0')
}

const symbolNumber = s => Number(s.number)

function isTerrainSymbol(symbol) {
  return (
    symbol !== undefined &&
    symbol.type !== TEXT_SYMBOL_TYPE &&
    symbolNumber(symbol) < FIRST_NON_TERRAIN_SYMBOL
  )
}

function boundsOf(objects, project) {
  const b = [Infinity, Infinity, -Infinity, -Infinity]
  for (const o of objects) {
    for (const c of Object.values(o.objIndex.rc)) {
      const [x, y] = project(c)
      b[0] = Math.min(b[0], x)
      b[1] = Math.min(b[1], y)
      b[2] = Math.max(b[2], x)
      b[3] = Math.max(b[3], y)
    }
  }
  return b
}

function snapOutward(b, step) {
  return [
    Math.floor(b[0] / step) * step,
    Math.floor(b[1] / step) * step,
    Math.ceil(b[2] / step) * step,
    Math.ceil(b[3] / step) * step,
  ]
}

// SVG matrix mapping ocad2geojson's SVG coordinates (paper x, -paper y) to
// projected metres with y pointing down (x, -northing).
function paperToProjectedSvgMatrix(crs) {
  const s = crs.scale / PAPER_UNITS_PER_M
  const g = -crs.grivation
  const c = Math.cos(g)
  const sn = Math.sin(g)
  return [s * c, -s * sn, s * sn, s * c, crs.easting, -crs.northing]
}

// ocad2geojson sets element ids as properties, which xmldom does not serialise; copy
// them to attributes so pattern fills (marsh, undergrowth) can be referenced.
function fixIds(node) {
  if (node.id) node.setAttribute('id', node.id)
  for (let i = 0; node.childNodes && i < node.childNodes.length; i++) fixIds(node.childNodes[i])
}

function renderSvg(ocadFile, objects, crs, extent, pxPerM) {
  const doc = ocadToSvg(ocadFile, {
    objects,
    document: new DOMImplementation().createDocument(null, 'xml', null),
  })
  const svg = doc.documentElement ?? doc
  fixIds(svg)
  const [x0, y0, x1, y1] = extent
  svg.setAttribute('viewBox', `${x0} ${-y1} ${x1 - x0} ${y1 - y0}`)
  svg.setAttribute('width', String((x1 - x0) * pxPerM))
  svg.setAttribute('height', String((y1 - y0) * pxPerM))
  svg.setAttribute('fill', 'transparent')
  for (let i = 0; i < svg.childNodes.length; i++) {
    const node = svg.childNodes[i]
    if (node.nodeName === 'g') {
      node.setAttribute('transform', `matrix(${paperToProjectedSvgMatrix(crs).join(' ')})`)
    }
  }
  return new XMLSerializer().serializeToString(svg)
}

function writePng(svgText, file) {
  const png = new Resvg(svgText, { background: 'white', fitTo: { mode: 'original' } })
    .render()
    .asPng()
  fs.writeFileSync(file, png)
}

// ocad2geojson gives each feature id = index + 1 in the object list it was given.
function simplifyFeatures(geojson, symbolsByNum) {
  return {
    type: 'FeatureCollection',
    features: geojson.features
      .filter(f => f.geometry)
      .map(f => {
        const symbol = symbolsByNum.get(f.properties.sym)
        return {
          type: 'Feature',
          geometry: f.geometry,
          properties: {
            oid: f.id - 1,
            sym: symbol.number,
            type: symbol.type,
            ang: (f.properties.ang ?? 0) / 10,
          },
        }
      }),
  }
}

async function main() {
  // ocad2geojson logs harmless warnings ("Ignoring rectangle symbol ...") on stdout.
  const log = console.log
  console.log = (...args) => console.error(...args)
  const ocadFile = await readOcad(mapPath)
  console.log = log

  const crs = ocadFile.getCrs()
  crs.easting += offsetX
  crs.northing += offsetY
  const project = crs.toProjectedCoord.bind(crs)
  const symbolsByNum = new Map(ocadFile.symbols.map(s => [s.symNum, s]))

  // objIndex.status: 1 = normal, 2 = hidden (deleted objects are already dropped).
  const visible = ocadFile.objects.filter(o => {
    const symbol = symbolsByNum.get(o.sym)
    return o.objIndex.status === 1 && symbol !== undefined && !symbol.isHidden()
  })
  const terrainObjects = visible.filter(o => isTerrainSymbol(symbolsByNum.get(o.sym)))
  if (terrainObjects.length === 0) {
    throw new Error('The map has no terrain objects (symbols 1xx-5xx)')
  }

  const mapBounds = boundsOf(terrainObjects, project)
  const extent =
    fixedExtent ??
    snapOutward(
      [mapBounds[0] - margin, mapBounds[1] - margin, mapBounds[2] + margin, mapBounds[3] + margin],
      align
    )
  let drapeObjects = terrainObjects
  if (opts.keep) {
    const keep = new Set(JSON.parse(fs.readFileSync(opts.keep, 'utf8')))
    const terrain = new Set(terrainObjects)
    drapeObjects = visible.filter((o, i) => keep.has(i) && terrain.has(o))
  }

  fs.mkdirSync(outDir, { recursive: true })

  const counts = new Map()
  for (const o of ocadFile.objects) counts.set(o.sym, (counts.get(o.sym) ?? 0) + 1)

  const meta = {
    source: path.resolve(mapPath),
    ocadVersion: `${ocadFile.header.version}.${ocadFile.header.subVersion}`,
    scale: crs.scale,
    crs: {
      catalog: crs.catalog,
      code: crs.code,
      name: crs.name,
      gridId: crs.gridId,
      easting: crs.easting,
      northing: crs.northing,
      offset: [offsetX, offsetY],
      grivationDeg: (crs.grivation * 180) / Math.PI,
    },
    mapBounds,
    extent,
    mapPxPerM,
    drapePxPerM,
    symbols: ocadFile.symbols
      .filter(s => counts.has(s.symNum))
      .map(s => ({
        number: s.number,
        type: s.type,
        description: s.description,
        objects: counts.get(s.symNum),
      })),
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))

  const geojson = ocadToGeoJson(ocadFile, {
    objects: visible,
    generateSymbolElements: false,
    coordinatePrecision: 2,
  })
  fs.writeFileSync(
    path.join(outDir, 'objects.geojson'),
    JSON.stringify(simplifyFeatures(geojson, symbolsByNum))
  )

  const mapSvg = renderSvg(ocadFile, visible, crs, extent, mapPxPerM)
  fs.writeFileSync(path.join(outDir, 'map.svg'), mapSvg)
  if (!opts['no-png']) {
    writePng(mapSvg, path.join(outDir, 'map.png'))
    const drapeSvg = renderSvg(ocadFile, drapeObjects, crs, extent, drapePxPerM)
    writePng(drapeSvg, path.join(outDir, 'drape.png'))
  }
  console.error(`Exported ${visible.length} objects to ${outDir}`)
}

main().catch(err => {
  console.error(err.stack || String(err))
  process.exit(1)
})
