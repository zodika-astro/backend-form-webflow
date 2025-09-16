// test-geonames.js
const { getTimezoneAtMoment } = require('./utils/timezone');

async function testGeoNames() {
  console.log('Testing GeoNames API...');
  
  const result = await getTimezoneAtMoment({
    lat: -23.5505,    // São Paulo
    lng: -46.6333,
    birthDate: '1990-01-01',
    birthTime: '12:00',
    apiKey: process.env.GOOGLE_MAPS_API_KEY
  });
  
  console.log('Result:', result);
  console.log('GeoNames username present:', !!process.env.GEONAMES_USERNAME);
}

testGeoNames().catch(console.error);
