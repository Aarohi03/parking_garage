# ParkWise - Parking Garage Operations

## Problem

ParkWise is made for a busy multi-level city parking garage. An attendant needs
to check cars in, check them out, assign available spots, and charge the right
fee.

The garage has compact, standard, and EV spots. An EV car must use an EV spot.
Parking fees use a first-hour price, an additional-hour price, and a daily cap.
Part-hours are rounded up. The attendant can search by license plate, and the
system prevents two cars from using the same spot.

There are three extra requirements:

1. **T4 - Messy rate-card import:** The attendant can paste a messy rate card.
	The system removes or rejects junk data, saves the cleaned rates, and uses
	them when calculating fees.
2. **T2 - Automatic clock:** `POST /clock` checks a simulated time and closes
	and bills any open stay that is more than 24 hours old.
3. **T6 - Valet transfer:** An open stay can be transferred to a new plate.
	The spot, level, original entry time, and open status stay the same.

## Features

- One-page landing page and attendant dashboard.
- User registration and login.
- Check-in and checkout for vehicles.
- Compact, standard, and EV spot types.
- Multi-level spots shown in the spot list and parking log.
- Live availability counts.
- Search by license plate.
- Status filtering, pagination, and newest/oldest sorting.
- Rate-card import with cleaning and validation.
- Fees calculated from saved database rates.
- Automatic closing through `POST /clock`.
- Valet transfer for open stays.
- Transactions to prevent double parking.

## Setup and Run

Requirement: Node.js 22.5 or later. The project uses Node's built-in SQLite
support, so no packages need to be installed.

```bash
npm start
```

Open `http://localhost:3000` in a browser.

For development with automatic restart:

```bash
npm run dev
```

## Database

The application uses SQLite in `parking.db`.

- `users` stores registered attendants.
- `spots` stores spot code, type, level, and occupied status.
- `stays` stores each vehicle visit, including entry, checkout, and fee.
- `rates` stores the cleaned rate card used for billing.

The first run creates the database and sample spots on three levels. Existing
databases are migrated when the server starts. The existing spot IDs are kept.

The default rates are 200 for the first hour, 120 for each extra started hour,
and a daily maximum of 2400. These values can be changed by importing a rate
card through the dashboard or API.

## API Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Register with `name`, `email`, and `password`. |
| POST | `/api/auth/login` | Log in with `email` and `password`. |
| GET | `/api/spots` | List all spots. Supports an optional `type` filter. |
| GET | `/api/spots/availability` | Return total and free spot counts by type. |
| GET | `/api/rates` | Return the cleaned rates currently used for billing. |
| POST | `/api/rates/import` | Import rate-card text using `{ "text": "..." }`. |
| POST | `/clock` | Close and bill open stays older than 24 hours. Uses `{ "now": "..." }`. |
| GET | `/api/stays` | Search and list stays with `q`, `status`, `sort`, `page`, and `limit`. |
| POST | `/api/stays/check-in` | Check in using plate, driver, vehicle type, and spot ID. |
| POST | `/api/stays/:id/check-out` | Check out a stay and calculate its fee. |
| POST | `/api/stays/:id/transfer` | Change the plate of an open stay without changing its parking details. |

Invalid JSON returns HTTP 400. An occupied spot or duplicate open plate returns
HTTP 409. EV vehicles cannot be assigned to non-EV spots.

## Rate Import

The dashboard accepts CSV, tab-separated, pipe-separated, semicolon-separated,
or JSON-array data. It can clean values such as `₹200` and recognize common
aliases such as `small`, `regular`, and `electric`.

Invalid vehicle types, invalid numbers, duplicate vehicle types, and daily caps
below the first-hour price are rejected. Valid rows are saved in the `rates`
table and are used during checkout and automatic clock closing.

## Testing

Run syntax checks:

```bash
node --check server.js
node --check public/app.js
```

Start the server with `npm start`, then test the API using the browser, `curl`,
or another REST client. Test registration, login, spot availability, check-in,
checkout, search, pagination, sorting, rate import, `/clock`, and transfer.

Important checks include:

- An EV cannot use a standard or compact spot.
- Two cars cannot check into the same spot.
- An imported rate changes the checkout fee.
- `/clock` closes only stays older than 24 hours and does not bill them twice.
- Transfer changes only the plate and rejects a plate with another open stay.
- The spot becomes free after checkout or automatic closing.

## Project Files

- `server.js` - HTTP server, SQLite schema, fee logic, and REST API.
- `public/` - landing page, dashboard, and styles.
- `parking.db` - generated SQLite database.
- `README.md` - project instructions and API documentation.
- `REASONING.md` - design decisions and problem-solving explanation.
- `AI_LOGS.md` - unedited AI conversation log.
