-- migrate:up

-- Boletos e contas a pagar (luz, água, condomínio) lidos de foto ou PDF viram conta agendada.
alter table attachments drop constraint attachments_doc_type_check;
alter table attachments add constraint attachments_doc_type_check
  check (doc_type in ('bank_statement', 'card_bill', 'pension_statement', 'brokerage_note', 'position_statement', 'receipt', 'boleto', 'unknown'));

-- migrate:down
update attachments set doc_type = 'unknown' where doc_type = 'boleto';
alter table attachments drop constraint attachments_doc_type_check;
alter table attachments add constraint attachments_doc_type_check
  check (doc_type in ('bank_statement', 'card_bill', 'pension_statement', 'brokerage_note', 'position_statement', 'receipt', 'unknown'));
