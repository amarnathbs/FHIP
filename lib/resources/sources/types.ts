// R1.4 minimal Sources — spec §50: "expose a minimal source picker and
// source record creation flow... do not build a large standalone Source
// Library."

export interface SourceOption {
  id: string;
  source_name: string;
  document_title: string | null;
  url: string | null;
  source_type: string | null;
  publication_date: string | null;
  is_public: boolean;
}

export interface CreateSourceInput {
  source_name: string;
  document_title: string;
  url: string;
  source_type: string;
  publication_date: string; // '' or YYYY-MM-DD
  is_public: boolean;
}
