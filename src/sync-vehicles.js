/**
 * CarLink24 Vehicle Sync Script
 * 
 * This script:
 * 1. Reads dealer URLs from config/dealers.json
 * 2. Scrapes vehicle listings from mobile.de
 * 3. Checks fingerprints to skip existing listings
 * 4. Screenshots images and uploads to Supabase Storage
 * 5. Inserts new listings to the database
 */

import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

// ===========================================
// Configuration
// ===========================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Sync log for debugging
const syncLog = {
  startedAt: new Date().toISOString(),
  dealers: [],
  listingsFound: 0,
  listingsNew: 0,
  listingsSkipped: 0,
  imagesUploaded: 0,
  errors: [],
  completedAt: null
};

// ===========================================
// Translation Maps (German → Normalized Keys)
// ===========================================

const fuelTypeMap = {
  'Benzin': 'PETROL',
  'Diesel': 'DIESEL',
  'Elektro': 'ELECTRIC',
  'Hybrid': 'HYBRID',
  'Hybrid (Benzin)': 'HYBRID_PETROL',
  'Hybrid (Benzin/Elektro)': 'HYBRID_PETROL',
  'Hybrid (Diesel)': 'HYBRID_DIESEL',
  'Plug-in-Hybrid': 'PLUGIN_HYBRID',
  'LPG': 'LPG',
  'CNG': 'CNG',
  'Erdgas': 'CNG',
  'Wasserstoff': 'HYDROGEN'
};

const gearboxMap = {
  'Automatik': 'AUTOMATIC',
  'Schaltgetriebe': 'MANUAL',
  'Schaltung': 'MANUAL',
  'Halbautomatik': 'SEMI_AUTOMATIC'
};

const bodyTypeMap = {
  'Limousine': 'SEDAN',
  'Kombi': 'WAGON',
  'SUV': 'SUV',
  'Geländewagen': 'SUV',
  'Coupé': 'COUPE',
  'Coupe': 'COUPE',
  'Sportwagen/Coupé': 'SPORTS_COUPE',
  'Sportwagen': 'SPORTS',
  'Cabrio': 'CONVERTIBLE',
  'Cabriolet': 'CONVERTIBLE',
  'Roadster': 'ROADSTER',
  'Kleinwagen': 'COMPACT',
  'Van': 'VAN',
  'Van/Minibus': 'MPV',
  'Pickup': 'PICKUP',
  'Andere': 'OTHER'
};

const driveTypeMap = {
  'Verbrennungsmotor': 'ICE',
  'Elektro': 'ELECTRIC',
  'Elektroantrieb': 'ELECTRIC',
  'Hybrid': 'HYBRID',
  'Hybridantrieb': 'HYBRID',
  'Plug-in-Hybrid': 'PLUGIN_HYBRID'
};

const climateMap = {
  'Klimaanlage': 'AUTOMATIC',
  'Klimaautomatik': 'AUTOMATIC',
  '2-Zonen-Klimaautomatik': 'TWO_ZONE',
  '3-Zonen-Klimaautomatik': 'THREE_ZONE',
  '4-Zonen-Klimaautomatik': 'FOUR_ZONE',
  'Manuelle Klimaanlage': 'MANUAL'
};

const colorMap = {
  'Weiß': 'WHITE',
  'Schwarz': 'BLACK',
  'Silber': 'SILVER',
  'Grau': 'GRAY',
  'Rot': 'RED',
  'Blau': 'BLUE',
  'Grün': 'GREEN',
  'Braun': 'BROWN',
  'Beige': 'BEIGE',
  'Gold': 'GOLD',
  'Orange': 'ORANGE',
  'Gelb': 'YELLOW',
  'Violett': 'PURPLE',
  'Bronze': 'BRONZE',
  'Anthrazit': 'ANTHRACITE'
};

const interiorMaterialMap = {
  'Leder': 'LEATHER',
  'Vollleder': 'FULL_LEATHER',
  'Teilleder': 'PARTIAL_LEATHER',
  'Stoff': 'FABRIC',
  'Alcantara': 'ALCANTARA',
  'Velours': 'VELOUR'
};

// ===========================================
// Helper Functions
// ===========================================

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = level === 'error' ? '❌' : level === 'success' ? '✅' : 'ℹ️';
  console.log(`${timestamp} ${prefix} ${message}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateFingerprint(make, model, mileage, firstRegistration) {
  const str = `${make || ''}|${model || ''}|${mileage || ''}|${firstRegistration || ''}`;
  return crypto.createHash('md5').update(str).digest('hex');
}

function generateSlug(make, model, year) {
  const base = `${make}-${model}-${year || 'unknown'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const random = crypto.randomBytes(4).toString('hex');
  return `${base}-${random}`;
}

function normalizeValue(value, map) {
  if (!value) return null;
  // Try exact match
  if (map[value]) return map[value];
  // Try case-insensitive match
  const lower = value.toLowerCase();
  for (const [key, val] of Object.entries(map)) {
    if (key.toLowerCase() === lower) return val;
  }
  // Try partial match
  for (const [key, val] of Object.entries(map)) {
    if (value.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return null;
}

function parseColor(colorString) {
  if (!colorString) return { color: null, metallic: false };
  const metallic = colorString.toLowerCase().includes('metallic');
  const colorOnly = colorString.replace(/\s*metallic\s*/i, '').trim();
  return {
    color: normalizeValue(colorOnly, colorMap),
    metallic
  };
}

function parseInterior(interiorString) {
  if (!interiorString) return { material: null, color: null };
  const parts = interiorString.split(',').map(p => p.trim());
  let material = null;
  let color = null;
  
  for (const part of parts) {
    if (!material) material = normalizeValue(part, interiorMaterialMap);
    if (!color) color = normalizeValue(part, colorMap);
  }
  
  return { material, color };
}

function parseNumeric(value) {
  if (!value) return null;
  const cleaned = value.replace(/[^\d]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

function parsePower(powerString) {
  if (!powerString) return { kw: null, ps: null };
  const kwMatch = powerString.match(/(\d+)\s*kW/);
  const psMatch = powerString.match(/(\d+)\s*PS/);
  return {
    kw: kwMatch ? parseInt(kwMatch[1], 10) : null,
    ps: psMatch ? parseInt(psMatch[1], 10) : null
  };
}

function parseRegistration(regString) {
  if (!regString) return null;
  // Handle MM/YYYY format
  const match = regString.match(/(\d{2})\/(\d{4})/);
  if (match) {
    return `${match[2]}${match[1]}`; // YYYYMM
  }
  return regString;
}

function parseMakeModel(title) {
  if (!title) return { make: null, model: null };
  
  const knownMakes = [
    'Mercedes-Benz', 'BMW', 'Audi', 'Volkswagen', 'Porsche', 'Ford', 'Opel',
    'Toyota', 'Honda', 'Mazda', 'Nissan', 'Hyundai', 'Kia', 'Volvo', 'Skoda',
    'Seat', 'Renault', 'Peugeot', 'Citroën', 'Fiat', 'Alfa Romeo', 'Jaguar',
    'Land Rover', 'Range Rover', 'Mini', 'Tesla', 'Lexus', 'Infiniti'
  ];
  
  for (const make of knownMakes) {
    if (title.startsWith(make)) {
      const model = title.substring(make.length).trim();
      return { make, model };
    }
  }
  
  // Fallback: first word is make, rest is model
  const parts = title.split(' ');
  return {
    make: parts[0],
    model: parts.slice(1).join(' ')
  };
}

// ===========================================
// Supabase Functions
// ===========================================

async function getExistingFingerprints() {
  log('Loading existing fingerprints from database...');
  
  const { data, error } = await supabase
    .from('listings')
    .select('fingerprint')
    .not('fingerprint', 'is', null);
  
  if (error) {
    log(`Error loading fingerprints: ${error.message}`, 'error');
    return new Set();
  }
  
  const fingerprints = new Set(data.map(row => row.fingerprint));
  log(`Loaded ${fingerprints.size} existing fingerprints`, 'success');
  return fingerprints;
}

async function uploadImage(imageBuffer, listingSlug, imageIndex) {
  const fileName = `${listingSlug}/${imageIndex}.webp`;
  
  const { data, error } = await supabase.storage
    .from('vehicle-images')
    .upload(fileName, imageBuffer, {
      contentType: 'image/webp',
      upsert: true
    });
  
  if (error) {
    log(`Error uploading image: ${error.message}`, 'error');
    return null;
  }
  
  const { data: urlData } = supabase.storage
    .from('vehicle-images')
    .getPublicUrl(fileName);
  
  return urlData.publicUrl;
}

async function insertListing(listing) {
  const { data, error } = await supabase
    .from('listings')
    .insert(listing)
    .select('id, slug')
    .single();
  
  if (error) {
    log(`Error inserting listing: ${error.message}`, 'error');
    syncLog.errors.push({ type: 'insert', error: error.message, listing: listing.slug });
    return null;
  }
  
  return data;
}

// ===========================================
// Scraping Functions
// ===========================================

async function scrapeDealer(browser, dealerUrl, config, existingFingerprints) {
  const page = await browser.newPage();
  const listings = [];
  
  try {
    // Convert home.mobile.de URL to search URL
    let searchUrl = dealerUrl;
    const customerIdMatch = dealerUrl.match(/customerId=(\d+)/);
    if (customerIdMatch) {
      searchUrl = `https://suchen.mobile.de/fahrzeuge/search.html?s=Car&vc=Car&sid=${customerIdMatch[1]}`;
    }
    
    log(`Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);
    
    // Extract listing URLs from search results
    const listingUrls = await page.evaluate(() => {
      const urls = [];
      const seenIds = new Set();
      
      document.querySelectorAll('a[href*="/fahrzeuge/details.html?id="]').forEach(link => {
        const href = link.href;
        const idMatch = href.match(/[?&]id=(\d+)/);
        if (idMatch && !seenIds.has(idMatch[1])) {
          seenIds.add(idMatch[1]);
          urls.push({
            url: `https://suchen.mobile.de/fahrzeuge/details.html?id=${idMatch[1]}`,
            id: idMatch[1]
          });
        }
      });
      
      return urls;
    });
    
    log(`Found ${listingUrls.length} listings on search page`);
    
    // Limit listings per dealer
    const limitedUrls = listingUrls.slice(0, config.settings.maxListingsPerDealer);
    
    // Scrape each listing
    for (let i = 0; i < limitedUrls.length; i++) {
      const { url } = limitedUrls[i];
      
      try {
        log(`Scraping listing ${i + 1}/${limitedUrls.length}: ${url}`);
        const listing = await scrapeListingDetails(page, url, config, existingFingerprints);
        
        if (listing) {
          if (listing.skipped) {
            log(`Skipped (already exists): ${listing.title}`, 'info');
            syncLog.listingsSkipped++;
          } else {
            listings.push(listing);
            log(`Scraped: ${listing.make} ${listing.model}`, 'success');
          }
        }
        
        await delay(2000); // Be respectful
      } catch (err) {
        log(`Error scraping listing: ${err.message}`, 'error');
        syncLog.errors.push({ type: 'scrape', url, error: err.message });
      }
    }
    
  } catch (err) {
    log(`Error scraping dealer: ${err.message}`, 'error');
    syncLog.errors.push({ type: 'dealer', url: dealerUrl, error: err.message });
  } finally {
    await page.close();
  }
  
  return listings;
}

async function scrapeListingDetails(page, url, config, existingFingerprints) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);
  
  // Click "Mehr anzeigen" buttons to expand sections
  await page.evaluate(() => {
    document.querySelectorAll('a, button').forEach(el => {
      if (el.textContent?.trim() === 'Mehr anzeigen') {
        el.click();
      }
    });
  });
  await delay(500);
  
  // Extract all details
  const rawData = await page.evaluate(() => {
    const details = {};
    
    // Title
    details.title = document.title.split('für')[0].trim() || '';
    
    // Price
    document.querySelectorAll('*').forEach(el => {
      const text = el.textContent?.trim() || '';
      if (text.match(/^\d{1,3}(\.\d{3})*\s*€$/) && !details.price) {
        details.price = text.replace(/[^\d]/g, '');
      }
    });
    
    // Helper to find values
    const findValue = (labelText) => {
      const dt = Array.from(document.querySelectorAll('dt')).find(e => e.textContent?.trim() === labelText);
      if (dt) {
        const dd = dt.nextElementSibling;
        if (dd?.tagName === 'DD') {
          const value = dd.textContent?.trim();
          if (value && value.length < 150) return value;
        }
      }
      return '';
    };
    
    // Extract all fields
    details.mileage = findValue('Kilometerstand');
    details.power = findValue('Leistung');
    details.fuelType = findValue('Kraftstoffart');
    details.transmission = findValue('Getriebe');
    details.firstRegistration = findValue('Erstzulassung');
    details.owners = findValue('Fahrzeughalter') || findValue('Anzahl der Fahrzeughalter');
    details.condition = findValue('Fahrzeugzustand');
    details.bodyType = findValue('Kategorie');
    details.series = findValue('Baureihe');
    details.variant = findValue('Ausstattungslinie');
    details.hubraum = findValue('Hubraum');
    details.driveType = findValue('Antriebsart');
    details.seats = findValue('Anzahl Sitzplätze');
    details.doors = findValue('Anzahl der Türen');
    details.emissionClass = findValue('Schadstoffklasse');
    details.emissionSticker = findValue('Umweltplakette');
    details.hu = findValue('HU');
    details.climate = findValue('Klimatisierung');
    details.parkingAssist = findValue('Einparkhilfe');
    details.airbags = findValue('Airbags');
    details.colorManufacturer = findValue('Farbe (Hersteller)');
    details.color = findValue('Farbe');
    details.interior = findValue('Innenausstattung');
    details.weight = findValue('Gewicht');
    details.cylinders = findValue('Zylinder');
    details.tankSize = findValue('Tankgröße');
    
    // Subtitle
    const subheadlineEl = document.querySelector('aside h2 + p, [role="complementary"] h2 + p');
    if (subheadlineEl) {
      const subText = subheadlineEl.textContent?.trim();
      if (subText && !subText.includes('€') && subText.length < 200) {
        details.subtitle = subText;
      }
    }
    
    // Features
    const features = [];
    document.querySelectorAll('article').forEach(art => {
      const heading = art.querySelector('h2, h3');
      if (heading?.textContent?.includes('Ausstattung')) {
        art.querySelectorAll('li').forEach(li => {
          const text = li.textContent?.trim();
          if (text && text.length > 1 && text.length < 80) {
            features.push(text);
          }
        });
      }
    });
    details.features = features;
    
    // Images
    const images = [];
    const seenImages = new Set();
    document.querySelectorAll('img').forEach(img => {
      const src = img.src || '';
      if (!src.includes('img.classistatic.de/api/v1/mo-prod/images/')) return;
      const baseUrl = src.split('?')[0];
      if (!seenImages.has(baseUrl)) {
        seenImages.add(baseUrl);
        images.push(baseUrl + '?rule=mo-1600');
      }
    });
    details.images = images;
    
    return details;
  });
  
  // Parse make/model from title
  const { make, model } = parseMakeModel(rawData.title);
  
  // Parse registration and mileage for fingerprint
  const firstRegistration = parseRegistration(rawData.firstRegistration);
  const mileage = parseNumeric(rawData.mileage);
  
  // Generate fingerprint and check if exists
  const fingerprint = generateFingerprint(make, model, mileage, firstRegistration);
  
  if (existingFingerprints.has(fingerprint)) {
    return { skipped: true, title: rawData.title };
  }
  
  // Parse all other fields
  const { color, metallic } = parseColor(rawData.color);
  const { material: interiorMaterial, color: interiorColor } = parseInterior(rawData.interior);
  const { kw: powerKw, ps: powerPs } = parsePower(rawData.power);
  
  // Generate slug
  const year = firstRegistration ? firstRegistration.substring(0, 4) : null;
  const slug = generateSlug(make, model, year);
  
  // Process images (screenshot and upload)
  const imageUrls = [];
  const maxImages = Math.min(rawData.images.length, 10); // Limit to 10 images
  
  for (let i = 0; i < maxImages; i++) {
    const imageUrl = rawData.images[i];
    try {
      const uploadedUrl = await processAndUploadImage(page, imageUrl, slug, i, config);
      if (uploadedUrl) {
        imageUrls.push(uploadedUrl);
        syncLog.imagesUploaded++;
      }
    } catch (err) {
      log(`Error processing image ${i}: ${err.message}`, 'error');
    }
  }
  
  // Build listing object
  return {
    slug,
    fingerprint,
    make,
    model,
    model_description: rawData.subtitle || null,
    subtitle: rawData.subtitle || null,
    series: rawData.series || null,
    variant: rawData.variant || null,
    price: parseNumeric(rawData.price),
    currency: 'EUR',
    price_type: 'FIXED',
    mileage,
    first_registration: firstRegistration,
    fuel: normalizeValue(rawData.fuelType, fuelTypeMap),
    gearbox: normalizeValue(rawData.transmission, gearboxMap),
    power_kw: powerKw,
    power_ps: powerPs,
    cubic_capacity: parseNumeric(rawData.hubraum),
    cylinders: parseNumeric(rawData.cylinders),
    body_type: normalizeValue(rawData.bodyType, bodyTypeMap),
    drive_type: normalizeValue(rawData.driveType, driveTypeMap),
    num_doors: parseNumeric(rawData.doors),
    num_seats: parseNumeric(rawData.seats),
    exterior_color: color,
    exterior_color_manufacturer: rawData.colorManufacturer || null,
    metallic,
    interior_color: interiorColor,
    interior_material: interiorMaterial,
    climate: normalizeValue(rawData.climate, climateMap),
    airbags: rawData.airbags || null,
    emission_class: rawData.emissionClass || null,
    emission_sticker: rawData.emissionSticker || null,
    hu_valid_until: rawData.hu || null,
    num_previous_owners: parseNumeric(rawData.owners),
    accident_damaged: rawData.condition?.toLowerCase().includes('unfallfrei') ? false : null,
    condition: rawData.condition?.toLowerCase().includes('neuwagen') ? 'NEW' : 'USED',
    tank_size: parseNumeric(rawData.tankSize),
    weight: parseNumeric(rawData.weight),
    features: rawData.features || [],
    images: imageUrls,
    source_url: url, // Internal only - never expose!
    source: 'github_actions',
    sync_source: 'github_actions',
    synced_at: new Date().toISOString(),
    published: true,
    featured: false
  };
}

async function processAndUploadImage(page, imageUrl, listingSlug, imageIndex, config) {
  // Navigate to image URL and take screenshot
  const imagePage = await page.browser().newPage();
  
  try {
    await imagePage.setViewport({
      width: config.settings.imageWidth,
      height: config.settings.imageHeight
    });
    
    await imagePage.goto(imageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(1000);
    
    // Take screenshot
    const screenshotBuffer = await imagePage.screenshot({
      type: 'png',
      clip: {
        x: 0,
        y: 0,
        width: config.settings.imageWidth,
        height: config.settings.imageHeight
      }
    });
    
    // Convert to WebP and resize to ensure 4:3 aspect ratio
    const webpBuffer = await sharp(screenshotBuffer)
      .resize(config.settings.imageWidth, config.settings.imageHeight, {
        fit: 'cover',
        position: 'center'
      })
      .webp({ quality: 85 })
      .toBuffer();
    
    // Upload to Supabase
    const uploadedUrl = await uploadImage(webpBuffer, listingSlug, imageIndex);
    return uploadedUrl;
    
  } finally {
    await imagePage.close();
  }
}

// ===========================================
// Main Function
// ===========================================

async function main() {
  log('🚗 CarLink24 Vehicle Sync Started');
  
  // Load config
  const configPath = path.join(ROOT_DIR, 'config/dealers.json');
  let config;
  
  try {
    const configFile = await fs.readFile(configPath, 'utf-8');
    config = JSON.parse(configFile);
    log(`Loaded config with ${config.dealers.length} dealers`);
  } catch (err) {
    log(`Error loading config: ${err.message}`, 'error');
    process.exit(1);
  }
  
  // Check if enabled
  if (!config.settings.enabled) {
    log('Sync is disabled in config. Exiting.');
    process.exit(0);
  }
  
  // Override max listings if provided via environment
  const maxOverride = parseInt(process.env.MAX_LISTINGS_OVERRIDE || '0', 10);
  if (maxOverride > 0) {
    config.settings.maxTotalListings = maxOverride;
    log(`Max listings overridden to: ${maxOverride}`);
  }
  
  // Load existing fingerprints
  const existingFingerprints = await getExistingFingerprints();
  
  // Launch browser
  log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    let allListings = [];
    
    // Process each dealer
    for (const dealer of config.dealers) {
      log(`\n📍 Processing dealer: ${dealer.name}`);
      syncLog.dealers.push({ name: dealer.name, url: dealer.url });
      
      const listings = await scrapeDealer(browser, dealer.url, config, existingFingerprints);
      allListings = allListings.concat(listings);
      
      syncLog.listingsFound += listings.length;
      
      // Check total limit
      if (allListings.length >= config.settings.maxTotalListings) {
        log(`Reached max total listings (${config.settings.maxTotalListings})`);
        allListings = allListings.slice(0, config.settings.maxTotalListings);
        break;
      }
      
      await delay(3000); // Pause between dealers
    }
    
    // Insert new listings
    log(`\n💾 Inserting ${allListings.length} new listings to database...`);
    
    for (const listing of allListings) {
      const result = await insertListing(listing);
      if (result) {
        syncLog.listingsNew++;
        log(`Inserted: ${listing.make} ${listing.model} (${listing.slug})`, 'success');
      }
    }
    
  } finally {
    await browser.close();
  }
  
  // Save sync log
  syncLog.completedAt = new Date().toISOString();
  const logPath = path.join(ROOT_DIR, 'sync-log.json');
  await fs.writeFile(logPath, JSON.stringify(syncLog, null, 2));
  
  // Summary
  log('\n========================================');
  log('📊 SYNC SUMMARY');
  log('========================================');
  log(`Dealers processed: ${syncLog.dealers.length}`);
  log(`Listings found: ${syncLog.listingsFound}`);
  log(`Listings new (inserted): ${syncLog.listingsNew}`);
  log(`Listings skipped (existing): ${syncLog.listingsSkipped}`);
  log(`Images uploaded: ${syncLog.imagesUploaded}`);
  log(`Errors: ${syncLog.errors.length}`);
  log('========================================\n');
  
  if (syncLog.errors.length > 0) {
    log('Errors encountered:', 'error');
    syncLog.errors.forEach(err => log(`  - ${err.type}: ${err.error}`, 'error'));
  }
  
  log('🏁 Sync completed!', 'success');
}

// Run
main().catch(err => {
  log(`Fatal error: ${err.message}`, 'error');
  console.error(err);
  process.exit(1);
});
