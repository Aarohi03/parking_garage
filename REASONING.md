# Reasoning

## Problem Understanding

The project is for a multi-level city parking garage. Cars arrive and leave
throughout the day, so the attendant needs a quick way to record each visit.
The system must assign a free spot, prevent double parking, and calculate the
correct fee when the car leaves.

The garage has compact, standard, and EV spots. EV cars must use EV spots. The
fee has a first-hour price, an additional-hour price, and a daily maximum.
Part-hours are rounded up. The attendant also needs license-plate search for a
large parking log.

The project has three extra twists:

- T4 imports messy rate cards and uses cleaned rates for fees.
- T2 uses `POST /clock` to close and bill stays older than 24 hours.
- T6 transfers an open stay to a new plate without changing the spot or entry
  time.

## Thought Process

I first separated the garage inventory from individual parking visits. A spot
needs its own record because it has a type, level, and occupied state. A stay
needs a separate record because the same spot can be used by many cars over
time.

Next, I kept fee calculation on the server so the browser cannot change the
amount. When the rate-card twist was added, the hardcoded fee values were
replaced with saved rates from the database. The check-in and checkout updates
were placed in transactions so the stay and spot do not become inconsistent.

The clock requirement was implemented by reusing the same fee calculation and
closing only open stays older than 24 hours. The transfer requirement was
implemented as a plate-only update to the existing open stay, so the spot and
entry time do not change.

After each major change, I checked the syntax and diagnostics, tested the API,
and checked the related browser controls. Failed test commands were corrected
when the shell changed JavaScript expressions, and the application behavior was
then verified with simpler direct requests.

## Database Design

The project uses SQLite through Node's built-in SQLite module.

- `users` stores registered attendant accounts.
- `spots` stores the spot code, type, level, and whether the spot is occupied.
- `stays` stores the plate, driver, vehicle type, spot, entry time, checkout
  time, fee, and creator.
- `rates` stores one cleaned rate for each vehicle type.

A stay points to one spot using `spot_id`. The spot is marked occupied during an
active stay and free after checkout. The database also has indexes for plate
search and open stays.

Existing databases are migrated when the server starts. The level column is
added without changing existing spot IDs.

## Solving the Original Requirements

### Check-in and checkout

The check-in endpoint validates the plate, driver, vehicle type, and spot. It
checks that the spot is free and that an EV uses an EV spot. Checkout saves the
checkout time and fee, then marks the spot as free.

### Correct fees

The fee calculation uses started hours. The first hour uses `first_hour`, later
hours use `additional_hour`, and the result cannot be higher than `daily_cap`.
The server calculates the fee instead of trusting the browser.

### EV spots and no double parking

The browser shows only free EV spots when EV is selected. The server checks the
same rule, so it cannot be bypassed through a direct API request.

Check-in uses an immediate database transaction. It rechecks the spot while the
transaction is active before inserting the stay. This prevents two requests
from assigning the same spot.

### Search, pagination, and sorting

The stays endpoint supports plate search, active or closed status, newest or
oldest ordering, page number, and page size. The dashboard uses these options
to display a manageable parking log.

### Registration and landing page

The landing page explains the garage system and links to the attendant desk.
The auth dialog supports registration and login. A successful login is saved in
the browser so the user can be associated with check-ins.

### Multi-level garage

Every spot has a numeric level. The level appears in the check-in spot list and
in each parking-log entry.

## Solving the Three Twists

### T4 - Messy rate-card import

The dashboard sends pasted rate-card text to `POST /api/rates/import`.

The importer accepts common separated formats and JSON arrays. It normalizes
vehicle names, removes currency symbols and comma formatting from numbers, and
rejects bad rows. It also rejects unknown vehicle types, duplicate types, and a
daily cap lower than the first-hour price.

The valid rows are saved in the `rates` table. Checkout and `/clock` read the
rate for the vehicle type from this table, so imported values affect billing.

### T2 - Automatic clock

`POST /clock` receives a simulated timestamp in the `now` field. It finds open
stays whose parking time is more than 24 hours at that timestamp.

For every matching stay, it saves the simulated checkout time, calculates the
fee from the saved rate, and frees the spot. The operation is transactional.
Closed stays are not selected by the next call, so calling `/clock` again does
not charge the same stay twice.

### T6 - Valet transfer

The parking log has a Transfer button for open stays. The button sends the new
plate to `POST /api/stays/:id/transfer`.

The API checks that the source stay is still open and that the new plate does
not already have another open stay. It updates only the plate field. The stay
ID, spot ID, level, original entry time, and open status remain unchanged.

## Testing and Fixes

The project was tested with JavaScript syntax checks, workspace diagnostics,
API requests, and browser checks.

The tests covered:

- Registration and login.
- Spot lists, levels, and availability counts.
- Normal check-in and checkout.
- Correct first-hour fee and saved rate-card fees.
- EV-to-non-EV rejection.
- Occupied-spot and duplicate-plate rejection.
- Search, status filtering, pagination, and sorting.
- Messy rate import, junk-row rejection, and rate persistence.
- `/clock` validation, automatic checkout, fee calculation, spot release, and
  repeated-call idempotence.
- Transfer preservation and duplicate active-plate rejection.
- Browser rendering of the landing page, rate import panel, level labels, and
  Transfer button.

During development, transactions were added around operations that update both
a stay and a spot. This keeps the two records consistent when a request fails
or when two attendants try to use the same spot at nearly the same time.
