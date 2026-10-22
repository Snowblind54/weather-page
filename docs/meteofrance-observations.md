# Activate official Météo-France national observations

The national adapter uses Météo-France's **Paquet Observations** API. One bulk
GeoJSON request retrieves the six-minute observation package; the collector
keeps mainland France and Corsica and publishes the existing shared snapshots.
Visitors never call the authenticated API. The existing 10-minute collection
schedule remains in use. Available station counts depend on reporting sensors.

## One-time activation

1. Sign in to <https://portail-api.meteofrance.fr/> and subscribe to
   **Paquet Observations** (`DonneesPubliquesPaquetObservation`). Generate an
   **API Key** for that API. A Climatology-only key does not enable this feed.
2. In `Snowblind54/weather-page`, open **Settings → Secrets and variables →
   Actions → New repository secret**. Name it `METEOFRANCE_API_KEY` and paste
   the key as its value. Keep the value in the secret, never in source code,
   workflow YAML, repository variables, browser settings or chat.
3. Run **Update official station temperatures** and **Update official Northern
   Europe wind**, or let their next scheduled runs collect the data.

Successful logs contain `FR: Météo-France national API: ... temperature stations`
and `FR: Météo-France national API: ... wind stations`. Stations use `MF-` IDs
and source `Météo-France / official national six-minute observations`.
If the key is missing, expired or unauthorized, logs explicitly say that the
national API is unavailable and the official SYNOP backup is being used.
The expanded national network is **not active** while those messages appear.
The current source description and observation times remain attached to each
station. Network switches exclude the other network's history to avoid
duplicate stations and mixed measurement periods.

## Data contract

- `validity_time` is the actual UTC measurement time. `reference_time` and
  `insert_time` never replace it. Requests allow 12 minutes for delivery.
- `t` is shelter air temperature in Kelvin, converted to °C.
- `ff` is measured mean wind at 10 m in m/s; `dd` is its direction in degrees.
- `raf10` is the maximum gust during the preceding 10 minutes in m/s.
  The earlier schema called this `fxi10`. Missing values remain unavailable;
  maximum mean wind, hourly gusts and daily maxima are never substituted.
- Primary-feed station labels expire after 95 minutes. Three-hourly SYNOP
  backup labels retain their own maximum age. Map heatmaps and animated
  particles keep their existing behavior.
- Human-readable station names are cached from the official station catalogue
  for 24 hours. If that catalogue is unavailable, the authenticated package's
  official IDs and geographic coordinates are sufficient to display stations.

## References and validation

- [Official package API documentation](https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/854851588/API+Paquet+Observations)
- [Official network/parameter documentation](https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/888143886/Observations+in+situ)
- [Official current station metadata](https://www.data.gouv.fr/api/1/datasets/r/4250e317-1176-425d-880c-ebe9205efc89)

`python3 -m unittest discover -s tests -p test_meteofrance_observations.py -v`
tests representative contract fixtures. These are not captured authenticated
responses. An authenticated live run is still required to verify activation
and the actual national station counts. Source attribution: **Météo-France**;
observations are provisional and published under the Licence Ouverte.
