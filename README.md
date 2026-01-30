# CarLink24 Scraper

Automated vehicle listing scraper that syncs from mobile.de dealers to the CarLink24 website.

## 📁 Project Structure

```
carlink24-scraper/
├── .github/
│   └── workflows/
│       └── sync-vehicles.yml   # GitHub Actions workflow
├── config/
│   └── dealers.json            # Dealer URLs & settings
├── src/
│   └── sync-vehicles.js        # Main sync script
├── package.json
└── README.md
```

## 🔄 How It Works

1. **Scheduled Run**: Every Sunday at 3:00 AM UTC
2. **Scrape Dealers**: Visits each dealer's mobile.de page
3. **Check Duplicates**: Uses fingerprinting to skip existing listings
4. **Process Images**: Screenshots vehicle images, uploads to Supabase Storage
5. **Insert to Database**: Adds new listings to Supabase

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   mobile.de     │────▶│  This Scraper   │────▶│    Supabase     │
│   (Dealers)     │     │ (GitHub Actions)│     │   (Database)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │  CarLink24.com  │
                                                │   (Website)     │
                                                └─────────────────┘
```

## ⚙️ Configuration

Edit `config/dealers.json` to manage dealers and settings:

```json
{
  "dealers": [
    {
      "name": "Dealer Name",
      "url": "https://home.mobile.de/home/index.html?customerId=12345678"
    }
  ],
  "settings": {
    "maxListingsPerDealer": 100,
    "maxTotalListings": 200,
    "imageWidth": 1200,
    "imageHeight": 800,
    "enabled": true
  }
}
```

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `maxListingsPerDealer` | Max listings to scrape per dealer | 100 |
| `maxTotalListings` | Max total listings per sync run | 200 |
| `imageWidth` | Screenshot width in pixels | 1200 |
| `imageHeight` | Screenshot height in pixels | 800 |
| `enabled` | Enable/disable sync | true |

## 🚀 Manual Trigger

1. Go to **Actions** tab in this GitHub repo
2. Select **"Sync Vehicles from Mobile.de"**
3. Click **"Run workflow"**
4. Optionally set max listings override
5. Click **"Run workflow"** button

## 📋 View Logs

1. Go to **Actions** tab
2. Click on any workflow run
3. Click on **"Sync Vehicle Listings"** job
4. Expand steps to see detailed logs
5. Download `sync-log.json` artifact for full details

## ⏸️ Disable Sync

### Option 1: Config file
Set `"enabled": false` in `config/dealers.json`

### Option 2: GitHub UI
1. Go to **Actions** tab
2. Click **"Sync Vehicles from Mobile.de"** in left sidebar
3. Click **"..."** menu → **"Disable workflow"**

## 🔐 Required Secrets

Set these in **Settings > Secrets and variables > Actions**:

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |

## 🔒 Data Privacy

The scraper:
- ✅ Stores `source_url` internally (for contacting sellers)
- ❌ Does NOT expose mobile.de IDs publicly
- ❌ Does NOT store dealer IDs or names
- ❌ Does NOT store location data
- ✅ Replaces image URLs with Supabase Storage URLs

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Run sync
npm run sync
```

## 📊 Duplicate Detection

Listings are identified by a fingerprint hash of:
- Make
- Model  
- Mileage
- First Registration Date

If a listing with the same fingerprint exists, it's skipped.

## ❓ Troubleshooting

### Sync failed
- Check workflow logs in GitHub Actions
- Download `sync-log.json` artifact for errors

### Images not uploading
- Verify `SUPABASE_SERVICE_ROLE_KEY` is correct
- Check `vehicle-images` bucket exists in Supabase

### No listings found
- Verify dealer URLs are correct
- Check if mobile.de page structure changed
