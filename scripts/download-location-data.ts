/**
 * Download US states, counties, and countries data into data/ folder.
 * Run: npx tsx scripts/download-location-data.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

// All 50 US states + DC + territories
const US_STATES = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' }, { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' }, { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' },
  { code: 'PR', name: 'Puerto Rico' }, { code: 'GU', name: 'Guam' }, { code: 'VI', name: 'U.S. Virgin Islands' },
  { code: 'AS', name: 'American Samoa' }, { code: 'MP', name: 'Northern Mariana Islands' },
];

async function downloadCounties(): Promise<Array<{ county: string; state: string; stateCode: string }>> {
  // Fetch from US Census Bureau FIPS codes
  const url = 'https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt';
  console.log('Downloading US counties from Census Bureau...');
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    
    const counties: Array<{ county: string; state: string; stateCode: string }> = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
      if (!line.trim()) continue;
      // Format: STATE|STATEFP|COUNTYFP|COUNTYNS|COUNTYNAME
      const parts = line.split('|');
      if (parts.length >= 5 && parts[0] !== 'STATE') {
        const stateCode = parts[0];
        const countyName = parts[4].trim();
        const stateInfo = US_STATES.find(s => s.code === stateCode);
        if (stateInfo && countyName) {
          counties.push({
            county: countyName,
            state: stateInfo.name,
            stateCode: stateInfo.code,
          });
        }
      }
    }
    
    console.log(`  Parsed ${counties.length} counties from Census data`);
    return counties;
  } catch (err) {
    console.warn('  Census download failed, using fallback Texas counties');
    return getFallbackTexasCounties();
  }
}

function getFallbackTexasCounties(): Array<{ county: string; state: string; stateCode: string }> {
  // Texas counties as fallback (most relevant for this legal app)
  const txCounties = [
    'Anderson', 'Andrews', 'Angelina', 'Aransas', 'Archer', 'Armstrong', 'Atascosa', 'Austin',
    'Bailey', 'Bandera', 'Bastrop', 'Baylor', 'Bee', 'Bell', 'Bexar', 'Blanco', 'Borden', 'Bosque',
    'Bowie', 'Brazoria', 'Brazos', 'Brewster', 'Briscoe', 'Brooks', 'Brown', 'Burleson', 'Burnet',
    'Caldwell', 'Calhoun', 'Callahan', 'Cameron', 'Camp', 'Carson', 'Cass', 'Castro', 'Chambers',
    'Cherokee', 'Childress', 'Clay', 'Cochran', 'Coke', 'Coleman', 'Collin', 'Collingsworth',
    'Colorado', 'Comal', 'Comanche', 'Concho', 'Cooke', 'Coryell', 'Cottle', 'Crane', 'Crockett',
    'Crosby', 'Culberson', 'Dallam', 'Dallas', 'Dawson', 'DeWitt', 'Deaf Smith', 'Delta', 'Denton',
    'Dickens', 'Dimmit', 'Donley', 'Duval', 'Eastland', 'Ector', 'Edwards', 'El Paso', 'Ellis',
    'Erath', 'Falls', 'Fannin', 'Fayette', 'Fisher', 'Floyd', 'Foard', 'Fort Bend', 'Franklin',
    'Freestone', 'Frio', 'Gaines', 'Galveston', 'Garza', 'Gillespie', 'Glasscock', 'Goliad',
    'Gonzales', 'Gray', 'Grayson', 'Gregg', 'Grimes', 'Guadalupe', 'Hale', 'Hall', 'Hamilton',
    'Hansford', 'Hardeman', 'Hardin', 'Harris', 'Harrison', 'Hartley', 'Haskell', 'Hays', 'Hemphill',
    'Henderson', 'Hidalgo', 'Hill', 'Hockley', 'Hood', 'Hopkins', 'Houston', 'Howard', 'Hudspeth',
    'Hunt', 'Hutchinson', 'Irion', 'Jack', 'Jackson', 'Jasper', 'Jeff Davis', 'Jefferson', 'Jim Hogg',
    'Jim Wells', 'Johnson', 'Jones', 'Karnes', 'Kaufman', 'Kendall', 'Kenedy', 'Kent', 'Kerr',
    'Kimble', 'King', 'Kinney', 'Kleberg', 'Knox', 'La Salle', 'Lamar', 'Lamb', 'Lampasas',
    'Lavaca', 'Lee', 'Leon', 'Liberty', 'Limestone', 'Lipscomb', 'Live Oak', 'Llano', 'Loving',
    'Lubbock', 'Lynn', 'Madison', 'Marion', 'Martin', 'Mason', 'Matagorda', 'Maverick', 'McCulloch',
    'McLennan', 'McMullen', 'Medina', 'Menard', 'Midland', 'Milam', 'Mills', 'Mitchell', 'Montague',
    'Montgomery', 'Moore', 'Morris', 'Motley', 'Nacogdoches', 'Navarro', 'Newton', 'Nolan',
    'Nueces', 'Ochiltree', 'Oldham', 'Orange', 'Palo Pinto', 'Panola', 'Parker', 'Parmer', 'Pecos',
    'Polk', 'Potter', 'Presidio', 'Rains', 'Randall', 'Reagan', 'Real', 'Red River', 'Reeves',
    'Refugio', 'Roberts', 'Robertson', 'Rockwall', 'Runnels', 'Rusk', 'Sabine', 'San Augustine',
    'San Jacinto', 'San Patricio', 'San Saba', 'Schleicher', 'Scurry', 'Shackelford', 'Shelby',
    'Sherman', 'Smith', 'Somervell', 'Starr', 'Stephens', 'Sterling', 'Stonewall', 'Sutton',
    'Swisher', 'Tarrant', 'Taylor', 'Terrell', 'Terry', 'Throckmorton', 'Titus', 'Tom Green',
    'Travis', 'Trinity', 'Tyler', 'Upshur', 'Upton', 'Uvalde', 'Val Verde', 'Van Zandt', 'Victoria',
    'Walker', 'Waller', 'Ward', 'Washington', 'Webb', 'Wharton', 'Wheeler', 'Wichita', 'Wilbarger',
    'Willacy', 'Williamson', 'Wilson', 'Winkler', 'Wise', 'Wood', 'Yoakum', 'Young', 'Zapata', 'Zavala',
  ];
  return txCounties.map(c => ({ county: `${c} County`, state: 'Texas', stateCode: 'TX' }));
}

// Common countries
const COUNTRIES = [
  'United States', 'Canada', 'Mexico', 'United Kingdom', 'Germany', 'France', 'Italy', 'Spain',
  'Australia', 'New Zealand', 'Japan', 'China', 'South Korea', 'India', 'Brazil', 'Argentina',
  'Colombia', 'Chile', 'Peru', 'Netherlands', 'Belgium', 'Switzerland', 'Austria', 'Sweden',
  'Norway', 'Denmark', 'Finland', 'Ireland', 'Portugal', 'Poland', 'Czech Republic', 'Greece',
  'Turkey', 'Israel', 'Saudi Arabia', 'United Arab Emirates', 'South Africa', 'Nigeria', 'Egypt',
  'Kenya', 'Singapore', 'Malaysia', 'Thailand', 'Philippines', 'Indonesia', 'Vietnam', 'Taiwan',
  'Hong Kong', 'Russia', 'Ukraine',
];

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // States
  fs.writeFileSync(path.join(DATA_DIR, 'us-states.json'), JSON.stringify(US_STATES, null, 2));
  console.log(`Wrote ${US_STATES.length} states to data/us-states.json`);

  // Counties
  const counties = await downloadCounties();
  fs.writeFileSync(path.join(DATA_DIR, 'us-counties.json'), JSON.stringify(counties, null, 2));
  console.log(`Wrote ${counties.length} counties to data/us-counties.json`);

  // Countries
  fs.writeFileSync(path.join(DATA_DIR, 'countries.json'), JSON.stringify(COUNTRIES, null, 2));
  console.log(`Wrote ${COUNTRIES.length} countries to data/countries.json`);

  console.log('Done!');
}

main().catch(console.error);
