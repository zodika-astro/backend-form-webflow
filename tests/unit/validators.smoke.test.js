// tests/unit/validators.smoke.test.js
'use strict';

const { validateBirthchartPayload } = require('../../modules/birthchart/validators');

describe('validators/birthchart — smoke', () => {
  test('accepts a minimal valid payload', () => {
    const payload = {
      name: 'Ana Maria',
      email: 'ANA@EXAMPLE.COM',
      birth_date: '1992-05-06',
      birth_time: '11:45',
      birth_place: 'Contagem',
      product_type: 'birth_chart',
      birth_place_lat: -19.93,
      birth_place_lng: -44.05,
    };

    const out = validateBirthchartPayload(payload);
    expect(out).toBeTruthy();
    expect(out.email).toBe('ana@example.com');           // lowercased
    expect(out.product_type).toBe('birth_chart');        // normalized
  });

  test('rejects an invalid time format', () => {
    const bad = {
      name: 'Ana',
      email: 'ana@example.com',
      birth_date: '1992-05-06',
      birth_time: '25:61', // invalid HH:MM
      birth_place: 'Contagem',
      product_type: 'birth_chart',
    };

    expect(() => validateBirthchartPayload(bad)).toThrow();
  });
});
