// Generate 24 hours of test data for each region
const regions = [
  'London', 'South East', 'South West', 'East of England',
  'West Midlands', 'East Midlands', 'Yorkshire', 'North West',
  'North East', 'Wales', 'Scotland', 'Northern Ireland'
];

const testData = [];
const now = new Date();

for (let i = 0; i < 24; i++) {
  const timestamp = new Date(now - i * 3600000).toISOString(); // Subtract hours

  regions.forEach((region, regionId) => {
    // Generate somewhat realistic looking data with some randomness
    const baseLoad = 1000 + Math.random() * 500;
    const peakMultiplier = Math.sin((i - 6) * Math.PI / 12) * 0.5 + 1; // Peak at noon
    
    testData.push(`
      INSERT INTO energy_usage (
        region_id, timestamp, demand_actual, 
        generation_mw, carbon_intensity, renewable_percentage
      ) VALUES (
        ${regionId + 1},
        '${timestamp}',
        ${Math.round(baseLoad * peakMultiplier)},
        ${Math.round(baseLoad * peakMultiplier * 1.1)},
        ${Math.round(200 + Math.random() * 100)},
        ${Math.round(20 + Math.random() * 40)}
      );
    `);
  });
}

console.log(`
-- Clear existing test data
DELETE FROM energy_usage;

-- Insert test data
${testData.join('\n')}
`); 