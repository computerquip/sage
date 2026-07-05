use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::{ArgAction, Parser, Subcommand, ValueEnum};
use fff_search::file_picker::{FFFMode, FilePicker, FilePickerOptions, FuzzySearchOptions};
use fff_search::git::format_git_status_opt;
use fff_search::grep::{GrepMode, GrepSearchOptions, has_regex_metacharacters};
use fff_search::{
    DirItem, FileItem, MixedItemRef, PaginationArgs, QueryParser, Score, SearchResult,
};
use serde::Serialize;

const DEFAULT_BASE: &str = "/workspace";
const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1_000;
const DEFAULT_TREE_DEPTH: usize = 3;
const MAX_TREE_DEPTH: usize = 25;
const DEFAULT_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Parser)]
#[command(name = "sage-fff")]
#[command(about = "FFF-backed JSON search for Sage VM sessions")]
struct Cli {
    #[arg(long, default_value = DEFAULT_BASE)]
    base: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Find {
        #[arg(long)]
        query: String,
        #[arg(long, default_value = ".")]
        path: String,
        #[arg(long, value_enum, default_value_t = FindMode::Mixed)]
        mode: FindMode,
        #[arg(long, default_value_t = DEFAULT_LIMIT)]
        limit: usize,
        #[arg(long, default_value_t = 0)]
        offset: usize,
    },
    Tree {
        #[arg(long, default_value = ".")]
        path: PathBuf,
        #[arg(long = "type", value_enum, default_value_t = EntryTypeArg::Any)]
        entry_type: EntryTypeArg,
        #[arg(long, default_value_t = DEFAULT_TREE_DEPTH)]
        max_depth: usize,
        #[arg(long, default_value_t = DEFAULT_LIMIT)]
        limit: usize,
        #[arg(long, default_value_t = false)]
        include_hidden: bool,
    },
    Grep {
        #[arg(long)]
        query: String,
        #[arg(long, default_value = ".")]
        path: String,
        #[arg(long, value_enum, default_value_t = GrepModeArg::Auto)]
        mode: GrepModeArg,
        #[arg(long, default_value_t = DEFAULT_LIMIT)]
        limit: usize,
        #[arg(long, default_value_t = 0)]
        file_offset: usize,
        #[arg(long, default_value_t = true, action = ArgAction::Set)]
        smart_case: bool,
        #[arg(long, default_value_t = DEFAULT_MAX_FILE_BYTES)]
        max_file_bytes: u64,
        #[arg(long, default_value_t = 0)]
        context: usize,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum FindMode {
    Files,
    Directories,
    Mixed,
    Glob,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum GrepModeArg {
    Auto,
    Plain,
    Regex,
    Fuzzy,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum EntryTypeArg {
    Any,
    File,
    Directory,
}

#[derive(Debug, Serialize)]
struct Response<T: Serialize> {
    command: &'static str,
    base_path: String,
    elapsed_ms: u128,
    result: T,
}

#[derive(Debug, Serialize)]
struct FindResponse {
    query: String,
    mode: String,
    total_matched: usize,
    total_files: usize,
    total_dirs: Option<usize>,
    offset: usize,
    limit: usize,
    next_offset: Option<usize>,
    items: Vec<FindItem>,
}

#[derive(Debug, Serialize)]
struct FindItem {
    path: String,
    name: String,
    kind: &'static str,
    size: Option<u64>,
    modified: Option<u64>,
    git_status: Option<String>,
    score: Option<ScoreItem>,
}

#[derive(Debug, Serialize)]
struct ScoreItem {
    total: i32,
    base_score: i32,
    exact_match: bool,
    match_type: &'static str,
}

#[derive(Debug, Serialize)]
struct TreeResponse {
    path: String,
    entry_type: String,
    max_depth: usize,
    limit: usize,
    include_hidden: bool,
    truncated: bool,
    items: Vec<TreeItem>,
}

#[derive(Debug, Serialize)]
struct TreeItem {
    path: String,
    name: String,
    kind: &'static str,
    depth: usize,
}

#[derive(Debug, Serialize)]
struct GrepResponse {
    query: String,
    effective_query: String,
    path: String,
    mode: String,
    total_matched: usize,
    total_files: usize,
    total_files_searched: usize,
    filtered_file_count: usize,
    files_with_matches: usize,
    next_file_offset: Option<usize>,
    regex_fallback_error: Option<String>,
    matches: Vec<GrepItem>,
}

#[derive(Debug, Serialize)]
struct GrepItem {
    path: String,
    name: String,
    line: u64,
    column: usize,
    byte_offset: u64,
    text: String,
    ranges: Vec<(u32, u32)>,
    is_definition: bool,
    git_status: Option<String>,
    size: u64,
    modified: u64,
    before: Vec<String>,
    after: Vec<String>,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let started = Instant::now();
    let base = normalize_base(&cli.base)?;

    match cli.command {
        Command::Find {
            query,
            path,
            mode,
            limit,
            offset,
        } => {
            let mut picker = build_picker(&base)?;
            let limit = normalize_limit(limit);
            let response = run_find(&mut picker, query, path, mode, limit, offset);
            print_response("find", &base, started, response)?;
        }
        Command::Tree {
            path,
            entry_type,
            max_depth,
            limit,
            include_hidden,
        } => {
            let limit = normalize_limit(limit);
            let max_depth = max_depth.min(MAX_TREE_DEPTH);
            let response = run_tree(&base, path, entry_type, max_depth, limit, include_hidden)?;
            print_response("tree", &base, started, response)?;
        }
        Command::Grep {
            query,
            path,
            mode,
            limit,
            file_offset,
            smart_case,
            max_file_bytes,
            context,
        } => {
            let mut picker = build_picker(&base)?;
            let limit = normalize_limit(limit);
            let response = run_grep(
                &mut picker,
                query,
                path,
                mode,
                limit,
                file_offset,
                smart_case,
                max_file_bytes,
                context,
            );
            print_response("grep", &base, started, response)?;
        }
    }

    Ok(())
}

fn normalize_base(base: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let base = fs::canonicalize(base)?;
    if !base.is_dir() {
        return Err(format!("base path is not a directory: {}", base.display()).into());
    }
    Ok(base)
}

fn build_picker(base: &Path) -> Result<FilePicker, Box<dyn std::error::Error>> {
    let mut picker = FilePicker::new(FilePickerOptions {
        base_path: base.to_string_lossy().into_owned(),
        enable_mmap_cache: false,
        enable_content_indexing: true,
        mode: FFFMode::Ai,
        cache_budget: None,
        watch: false,
        follow_symlinks: false,
        enable_fs_root_scanning: false,
        enable_home_dir_scanning: false,
    })?;
    picker.collect_files()?;
    Ok(picker)
}

fn normalize_limit(limit: usize) -> usize {
    limit.clamp(1, MAX_LIMIT)
}

fn search_options<'a>(limit: usize, offset: usize, base: &'a Path) -> FuzzySearchOptions<'a> {
    FuzzySearchOptions {
        max_threads: 0,
        current_file: None,
        project_path: Some(base),
        combo_boost_score_multiplier: 100,
        min_combo_count: 3,
        pagination: PaginationArgs { offset, limit },
    }
}

fn run_find(
    picker: &mut FilePicker,
    query: String,
    path: String,
    mode: FindMode,
    limit: usize,
    offset: usize,
) -> FindResponse {
    let effective_query = effective_query(&query, &path);
    let parser = QueryParser::default();
    let parsed = parser.parse(&effective_query);
    let base_path = picker.base_path().to_path_buf();

    match mode {
        FindMode::Files => {
            let result = picker.fuzzy_search(
                &parsed,
                None,
                search_options(limit, offset, &base_path),
            );
            find_response_from_files(picker, effective_query, "files", result, offset, limit)
        }
        FindMode::Directories => {
            let result = picker.fuzzy_search_directories(
                &parsed,
                search_options(limit, offset, &base_path),
            );
            let items = result
                .items
                .iter()
                .zip(result.scores.iter())
                .map(|(item, score)| dir_item(picker, item, Some(score)))
                .collect();
            FindResponse {
                query: effective_query,
                mode: "directories".to_string(),
                total_matched: result.total_matched,
                total_files: picker.live_file_count(),
                total_dirs: Some(result.total_dirs),
                offset,
                limit,
                next_offset: next_offset(offset, limit, result.total_matched),
                items,
            }
        }
        FindMode::Mixed => {
            let result = picker.fuzzy_search_mixed(
                &parsed,
                None,
                search_options(limit, offset, &base_path),
            );
            let items = result
                .items
                .iter()
                .zip(result.scores.iter())
                .map(|(item, score)| match item {
                    MixedItemRef::File(file) => file_item(picker, file, Some(score)),
                    MixedItemRef::Dir(dir) => dir_item(picker, dir, Some(score)),
                })
                .collect();
            FindResponse {
                query: effective_query,
                mode: "mixed".to_string(),
                total_matched: result.total_matched,
                total_files: result.total_files,
                total_dirs: Some(result.total_dirs),
                offset,
                limit,
                next_offset: next_offset(offset, limit, result.total_matched),
                items,
            }
        }
        FindMode::Glob => {
            let result = picker.glob(&query, search_options(limit, offset, &base_path));
            find_response_from_files(picker, query.clone(), "glob", result, offset, limit)
        }
    }
}

fn find_response_from_files(
    picker: &FilePicker,
    query: String,
    mode: &str,
    result: SearchResult<'_>,
    offset: usize,
    limit: usize,
) -> FindResponse {
    let items = result
        .items
        .iter()
        .zip(result.scores.iter())
        .map(|(item, score)| file_item(picker, item, Some(score)))
        .collect();
    FindResponse {
        query,
        mode: mode.to_string(),
        total_matched: result.total_matched,
        total_files: result.total_files,
        total_dirs: None,
        offset,
        limit,
        next_offset: next_offset(offset, limit, result.total_matched),
        items,
    }
}

fn file_item(picker: &FilePicker, item: &FileItem, score: Option<&Score>) -> FindItem {
    let path = item.relative_path(picker);
    let name = item.file_name(picker);
    FindItem {
        path,
        name,
        kind: "file",
        size: Some(item.size),
        modified: Some(item.modified),
        git_status: item
            .git_status
            .and_then(|status| format_git_status_opt(Some(status)))
            .map(str::to_string),
        score: score.map(score_item),
    }
}

fn dir_item(picker: &FilePicker, item: &DirItem, score: Option<&Score>) -> FindItem {
    let path = item.relative_path(picker);
    let name = item.dir_name(picker);
    FindItem {
        path,
        name,
        kind: "directory",
        size: None,
        modified: None,
        git_status: None,
        score: score.map(score_item),
    }
}

fn score_item(score: &Score) -> ScoreItem {
    ScoreItem {
        total: score.total,
        base_score: score.base_score,
        exact_match: score.exact_match,
        match_type: score.match_type,
    }
}

fn next_offset(offset: usize, returned_limit: usize, total: usize) -> Option<usize> {
    let next = offset.saturating_add(returned_limit);
    (next < total).then_some(next)
}

fn run_tree(
    base: &Path,
    raw_path: PathBuf,
    entry_type: EntryTypeArg,
    max_depth: usize,
    limit: usize,
    include_hidden: bool,
) -> Result<TreeResponse, Box<dyn std::error::Error>> {
    let root = resolve_under_base(base, &raw_path)?;
    let mut items = Vec::new();
    let mut truncated = false;
    visit_tree(
        base,
        &root,
        0,
        max_depth,
        limit,
        entry_type,
        include_hidden,
        &mut items,
        &mut truncated,
    )?;

    Ok(TreeResponse {
        path: relative_display(base, &root),
        entry_type: format!("{entry_type:?}"),
        max_depth,
        limit,
        include_hidden,
        truncated,
        items,
    })
}

fn visit_tree(
    base: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    limit: usize,
    entry_type: EntryTypeArg,
    include_hidden: bool,
    items: &mut Vec<TreeItem>,
    truncated: &mut bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if items.len() >= limit {
        *truncated = true;
        return Ok(());
    }

    let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| {
        let file_type = entry.file_type().ok();
        let type_rank = if file_type.as_ref().is_some_and(|ft| ft.is_dir()) {
            0
        } else {
            1
        };
        (type_rank, entry.file_name())
    });

    for entry in entries {
        if items.len() >= limit {
            *truncated = true;
            return Ok(());
        }

        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !include_hidden && file_name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let file_type = entry.file_type()?;
        let kind = if file_type.is_dir() {
            "directory"
        } else if file_type.is_file() {
            "file"
        } else if file_type.is_symlink() {
            "symlink"
        } else {
            "other"
        };

        if entry_type.allows(kind) {
            items.push(TreeItem {
                path: relative_display(base, &path),
                name: file_name,
                kind,
                depth,
            });
        }

        if file_type.is_dir() && depth < max_depth {
            visit_tree(
                base,
                &path,
                depth + 1,
                max_depth,
                limit,
                entry_type,
                include_hidden,
                items,
                truncated,
            )?;
        }
    }

    Ok(())
}

impl EntryTypeArg {
    fn allows(self, kind: &str) -> bool {
        matches!(
            (self, kind),
            (EntryTypeArg::Any, _)
                | (EntryTypeArg::File, "file")
                | (EntryTypeArg::Directory, "directory")
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn run_grep(
    picker: &mut FilePicker,
    query: String,
    path: String,
    mode: GrepModeArg,
    limit: usize,
    file_offset: usize,
    smart_case: bool,
    max_file_bytes: u64,
    context: usize,
) -> GrepResponse {
    let effective_query = effective_query(&query, &path);
    let parser = QueryParser::default();
    let parsed = parser.parse(&effective_query);
    let grep_text = parsed.grep_text();
    let grep_mode = match mode {
        GrepModeArg::Auto if has_regex_metacharacters(&grep_text) => GrepMode::Regex,
        GrepModeArg::Auto => GrepMode::PlainText,
        GrepModeArg::Plain => GrepMode::PlainText,
        GrepModeArg::Regex => GrepMode::Regex,
        GrepModeArg::Fuzzy => GrepMode::Fuzzy,
    };

    let options = GrepSearchOptions {
        max_file_size: max_file_bytes.max(1),
        max_matches_per_file: limit.min(200),
        smart_case,
        file_offset,
        page_limit: limit,
        mode: grep_mode,
        time_budget_ms: 0,
        before_context: context,
        after_context: context,
        classify_definitions: true,
        trim_whitespace: false,
        abort_signal: None,
    };
    let result = picker.grep(&parsed, &options);
    let matches = result
        .matches
        .iter()
        .map(|hit| {
            let file = result.files[hit.file_index];
            GrepItem {
                path: file.relative_path(&*picker),
                name: file.file_name(&*picker),
                line: hit.line_number,
                column: hit.col + 1,
                byte_offset: hit.byte_offset,
                text: hit.line_content.clone(),
                ranges: hit.match_byte_offsets.iter().copied().collect(),
                is_definition: hit.is_definition,
                git_status: file
                    .git_status
                    .and_then(|status| format_git_status_opt(Some(status)))
                    .map(str::to_string),
                size: file.size,
                modified: file.modified,
                before: hit.context_before.clone(),
                after: hit.context_after.clone(),
            }
        })
        .collect();

    GrepResponse {
        query,
        effective_query,
        path,
        mode: format!("{grep_mode:?}"),
        total_matched: result.matches.len(),
        total_files: result.total_files,
        total_files_searched: result.total_files_searched,
        filtered_file_count: result.filtered_file_count,
        files_with_matches: result.files_with_matches,
        next_file_offset: (result.next_file_offset != 0).then_some(result.next_file_offset),
        regex_fallback_error: result.regex_fallback_error,
        matches,
    }
}

fn effective_query(query: &str, path: &str) -> String {
    if path.trim().is_empty() || path == "." {
        query.to_string()
    } else {
        format!("{} {}", normalize_constraint_path(path), query)
    }
}

fn normalize_constraint_path(path: &str) -> String {
    let trimmed = path.trim().trim_start_matches("./");
    if trimmed.is_empty() || trimmed == "." {
        return String::new();
    }
    if trimmed.ends_with('/') || trimmed.contains('*') || trimmed.contains('?') {
        return trimmed.to_string();
    }
    if Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains('.'))
    {
        return trimmed.to_string();
    }
    format!("{trimmed}/")
}

fn resolve_under_base(base: &Path, path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let canonical = fs::canonicalize(candidate)?;
    if !canonical.starts_with(base) {
        return Err(format!("path escapes base: {}", path.display()).into());
    }
    Ok(canonical)
}

fn relative_display(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| ".".to_string())
}

fn print_response<T: Serialize>(
    command: &'static str,
    base: &Path,
    started: Instant,
    result: T,
) -> Result<(), Box<dyn std::error::Error>> {
    let response = Response {
        command,
        base_path: base.to_string_lossy().into_owned(),
        elapsed_ms: started.elapsed().as_millis(),
        result,
    };
    println!("{}", serde_json::to_string_pretty(&response)?);
    Ok(())
}
