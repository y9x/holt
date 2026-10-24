// node --test for the platform registry. Run with: npm test

import test from 'node:test'
import assert from 'node:assert/strict'

import { frameAncestors, parsePlatforms, platformForOrigin } from './platforms.ts'

const SECRET_A = 'a'.repeat(40)
const SECRET_B = 'b'.repeat(40)

function entry(overrides = {}) {
  return {
    id: 'nocturne',
    name: 'Nocturne',
    issuer: 'https://nocturne.lol',
    secret: SECRET_A,
    allowedOrigins: ['https://nocturne.lol'],
    links: { account: 'https://nocturne.lol/account', settings: 'https://nocturne.lol/account' },
    ...overrides,
  }
}

test('a platform defaults its namespace to its id and keeps optional links null', () => {
  const [platform] = parsePlatforms([entry()])
  assert.equal(platform.identityNamespace, 'nocturne')
  assert.equal(platform.links.verifyEmail, null)
  assert.equal(platform.links.signIn, null)
  assert.equal(frameAncestors(platform), 'frame-ancestors https://nocturne.lol')
})

test('two platforms may share a namespace and a secret when they share an account system', () => {
  const platforms = parsePlatforms([
    entry({ id: 'abulxt', issuer: 'https://a.example', allowedOrigins: ['https://a.example'] }),
    entry({ id: 'abstract', identityNamespace: 'abulxt', issuer: 'https://a.example', allowedOrigins: ['https://chat.example'] }),
  ])
  assert.equal(platforms[1].identityNamespace, 'abulxt')
  assert.equal(platformForOrigin(platforms, 'https://chat.example').id, 'abstract')
  assert.equal(platformForOrigin(platforms, 'https://elsewhere.example'), null)
})

test('a secret shared across namespaces is rejected', () => {
  assert.throws(() => parsePlatforms([entry(), entry({ id: 'other', allowedOrigins: ['https://other.example'] })]), /shares a secret/)
})

test('reserved namespaces, short secrets, http origins and duplicate ids are rejected', () => {
  assert.throws(() => parsePlatforms([entry({ identityNamespace: 'discord' })]), /reserved/)
  assert.throws(() => parsePlatforms([entry({ secret: 'short' })]), /at least 32/)
  assert.throws(() => parsePlatforms([entry({ allowedOrigins: ['http://nocturne.lol'] })]), /must be https/)
  assert.throws(() => parsePlatforms([entry({ allowedOrigins: ['https://nocturne.lol/'] })]), /not an origin/)
  assert.throws(() => parsePlatforms([entry(), entry({ secret: SECRET_B, identityNamespace: 'nocturne' })]), /duplicate id/)
  assert.throws(() => parsePlatforms([entry({ links: { account: 'https://nocturne.lol/account' } })]), /links.settings is required/)
})

test('localhost origins are allowed over http for development', () => {
  const [platform] = parsePlatforms([entry({ allowedOrigins: ['http://localhost:5173'] })])
  assert.deepEqual(platform.allowedOrigins, ['http://localhost:5173'])
})
