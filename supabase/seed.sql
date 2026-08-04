insert into currencies (currency_code, currency_name, currency_symbol, country_code) values
  ('AUD','Australian Dollar','$','AU'),
  ('INR','Indian Rupee','₹','IN')
on conflict do nothing;

insert into countries (country_code, country_name, default_currency_code, is_supported) values
  ('AU','Australia','AUD',true),
  ('IN','India','INR',true)
on conflict do nothing;
