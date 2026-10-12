-- migrate:up
-- Cotas de fundo e cotações têm mais casas que centavos; guardamos o valor exato também.
alter table asset_prices add column close numeric(20,8);
update asset_prices set close = close_cents / 100.0 where close is null;

-- migrate:down
alter table asset_prices drop column close;
