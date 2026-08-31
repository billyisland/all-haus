import { describe, expect, it } from 'vitest'
import { composePipStatus, type PipComposeInput } from './trust-pip.js'

const baseL1 = {
  accountAgeDays: 30,
  payingReaderCount: 0,
  articleCount: 0,
  paymentVerified: false,
  nip05Verified: false,
  encounterCount: 0,
}

const noPolls = {
  humanity: { yes: 0, no: 0 },
  authenticity: { yes: 0, no: 0 },
  good_faith: { yes: 0, no: 0 },
}

function input(overrides: Partial<{
  layer1: Partial<PipComposeInput['layer1']>
  polls: Partial<PipComposeInput['polls']>
}> = {}): PipComposeInput {
  return {
    layer1: { ...baseL1, ...(overrides.layer1 ?? {}) },
    polls: { ...noPolls, ...(overrides.polls ?? {}) },
  }
}

describe('composePipStatus', () => {
  describe('grey (unknown)', () => {
    it('no signal at all → unknown', () => {
      expect(composePipStatus(input())).toBe('unknown')
    })

    it('polls below sample floor → unknown', () => {
      // 2 yes / 0 no on every question — below SAMPLE_FLOOR of 3
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 2, no: 0 },
              authenticity: { yes: 2, no: 0 },
              good_faith: { yes: 2, no: 0 },
            },
          }),
        ),
      ).toBe('unknown')
    })

    it('weak L1 (1 article, no payment) → unknown', () => {
      expect(
        composePipStatus(input({ layer1: { articleCount: 1 } })),
      ).toBe('unknown')
    })

    it('ambiguous polls (50/50, sample met) without L1 → unknown', () => {
      // 5 yes / 5 no = 0.5 share — between 0.3 and 0.7, so ambiguous
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 5, no: 5 },
              authenticity: { yes: 5, no: 5 },
              good_faith: { yes: 5, no: 5 },
            },
          }),
        ),
      ).toBe('unknown')
    })
  })

  describe('amber (partial)', () => {
    it('one poll positive (≥0.7 yes-share, ≥3 sample) → partial', () => {
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 7, no: 1 },
              authenticity: { yes: 0, no: 0 },
              good_faith: { yes: 0, no: 0 },
            },
          }),
        ),
      ).toBe('partial')
    })

    it('strong L1 (3 articles + payment_verified) without polls → partial', () => {
      expect(
        composePipStatus(
          input({ layer1: { articleCount: 3, paymentVerified: true } }),
        ),
      ).toBe('partial')
    })

    it('all three polls positive but no L1 anchor → partial (not green)', () => {
      // No NIP-05 and no paying readers — even with all-positive polls, the
      // green bar requires a real platform-side commitment.
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 8, no: 1 },
              authenticity: { yes: 8, no: 1 },
              good_faith: { yes: 8, no: 1 },
            },
          }),
        ),
      ).toBe('partial')
    })

    it('authenticity-no with sample (humanity/good_faith fine) → partial, not contested', () => {
      // Authenticity is deliberately a weaker question than humanity or
      // good_faith — a "they're not who they seem" signal is yellow-flag,
      // not red.
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 7, no: 1 },
              authenticity: { yes: 0, no: 8 },
              good_faith: { yes: 7, no: 1 },
            },
            layer1: { nip05Verified: true },
          }),
        ),
      ).toBe('partial')
    })
  })

  describe('green (known)', () => {
    it('all three polls positive + nip05_verified → known', () => {
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 8, no: 1 },
              authenticity: { yes: 8, no: 1 },
              good_faith: { yes: 8, no: 1 },
            },
            layer1: { nip05Verified: true },
          }),
        ),
      ).toBe('known')
    })

    it('all three polls positive + paying readers → known', () => {
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 8, no: 1 },
              authenticity: { yes: 8, no: 1 },
              good_faith: { yes: 8, no: 1 },
            },
            layer1: { payingReaderCount: 5 },
          }),
        ),
      ).toBe('known')
    })

    it('all three polls positive but only one is just-at-threshold → known', () => {
      // 7 yes / 3 no = exactly 0.7 share
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 7, no: 3 },
              authenticity: { yes: 7, no: 3 },
              good_faith: { yes: 7, no: 3 },
            },
            layer1: { nip05Verified: true },
          }),
        ),
      ).toBe('known')
    })
  })

  describe('crimson (contested)', () => {
    it('humanity-no with sample → contested (overrides any L1)', () => {
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 0, no: 8 },
              authenticity: { yes: 8, no: 1 },
              good_faith: { yes: 8, no: 1 },
            },
            layer1: { nip05Verified: true, payingReaderCount: 50 },
          }),
        ),
      ).toBe('contested')
    })

    it('good_faith-no with sample → contested', () => {
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 8, no: 1 },
              authenticity: { yes: 8, no: 1 },
              good_faith: { yes: 0, no: 8 },
            },
            layer1: { nip05Verified: true },
          }),
        ),
      ).toBe('contested')
    })

    it('humanity-no but sample below floor → not contested', () => {
      // 0 yes / 2 no — total 2, below SAMPLE_FLOOR
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 0, no: 2 },
              authenticity: { yes: 0, no: 0 },
              good_faith: { yes: 0, no: 0 },
            },
          }),
        ),
      ).toBe('unknown')
    })
  })

  // Slice 18 — encounter (in-person met) is the hard upgrade path to green.
  // ≥1 encounter affirm joins NIP-05 / paying readers as an L1 anchor; ≥2 is
  // strong enough alone to lift the pip to amber even without other signals.
  describe('encounter (slice 18)', () => {
    it('encounter ≥1 anchors green when polls all positive (no other anchor)', () => {
      // Without nip05 or paying readers — encounter alone unlocks green.
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 8, no: 1 },
              authenticity: { yes: 8, no: 1 },
              good_faith: { yes: 8, no: 1 },
            },
            layer1: { encounterCount: 1 },
          }),
        ),
      ).toBe('known')
    })

    it('encounter = 0 still requires nip05 or paying readers for green', () => {
      // Regression guard for the pre-slice-18 anchor rule.
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 8, no: 1 },
              authenticity: { yes: 8, no: 1 },
              good_faith: { yes: 8, no: 1 },
            },
            layer1: { encounterCount: 0 },
          }),
        ),
      ).toBe('partial')
    })

    it('encounter ≥2 alone (no polls, no other L1) → partial', () => {
      // Two independent in-person meetings is enough to lift above grey even
      // without articles, payment, or polling volume.
      expect(
        composePipStatus(
          input({ layer1: { encounterCount: 2 } }),
        ),
      ).toBe('partial')
    })

    it('encounter = 1 alone → unknown (single claim isn’t enough on its own)', () => {
      expect(
        composePipStatus(
          input({ layer1: { encounterCount: 1 } }),
        ),
      ).toBe('unknown')
    })

    it('encounter does not override humanity-no (still contested)', () => {
      // The hard upgrade path doesn't bypass crimson — meeting someone in
      // person doesn't cancel multiple credible accounts of bad faith.
      expect(
        composePipStatus(
          input({
            polls: {
              humanity: { yes: 0, no: 8 },
              authenticity: { yes: 8, no: 1 },
              good_faith: { yes: 8, no: 1 },
            },
            layer1: { encounterCount: 5 },
          }),
        ),
      ).toBe('contested')
    })
  })
})
