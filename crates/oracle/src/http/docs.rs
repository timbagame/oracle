//! The HTML route listing served at `/` (`generateDocumentationHtml`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RouteDocumentation {
    pub path: &'static str,
    pub method: HttpMethod,
    pub summary: &'static str,
    pub request_example: Option<&'static str>,
}

fn escape_html(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

pub fn generate_documentation_html(routes: &[RouteDocumentation]) -> String {
    let sections: Vec<String> = routes
        .iter()
        .map(|route| {
            let method = route.method.as_str();
            let method_class: String =
                method.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-').collect();
            let method_class = if method_class.is_empty() { "custom".to_string() } else { method_class };
            let request_example = route
                .request_example
                .map(|example| format!("<br><strong>Body:</strong> <code>{}</code>", escape_html(example)))
                .unwrap_or_default();
            format!(
                "\n      <div class=\"endpoint\">\n        <span class=\"method {method_class}\">{}</span> <code>{}</code>\n        <div class=\"description\">{}{request_example}</div>\n      </div>",
                escape_html(method),
                escape_html(route.path),
                escape_html(route.summary),
            )
        })
        .collect();
    format!("{}{}{}", TEMPLATE_HEAD, sections.join("\n"), TEMPLATE_TAIL)
}

const TEMPLATE_HEAD: &str = r#"
  <!DOCTYPE html>
  <html>
    <head>
      <title>Oracle API Documentation</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 800px;
          margin: 50px auto;
          padding: 20px;
          line-height: 1.6;
          color: #333;
        }
        h1 {
          color: #2c3e50;
          border-bottom: 3px solid #3498db;
          padding-bottom: 10px;
        }
        h2 {
          color: #34495e;
          margin-top: 30px;
        }
        code {
          background: #f8f9fa;
          padding: 4px 8px;
          border-radius: 4px;
          font-family: 'Monaco', 'Consolas', monospace;
          border: 1px solid #e9ecef;
        }
        .endpoint {
          background: #ffffff;
          border: 1px solid #dee2e6;
          border-radius: 8px;
          padding: 15px;
          margin: 10px 0;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .method {
          font-weight: bold;
          padding: 2px 6px;
          border-radius: 3px;
          color: white;
          font-size: 12px;
        }
        .get { background-color: #28a745; }
        .post { background-color: #007bff; }
        .description {
          margin-top: 8px;
          color: #6c757d;
        }
      </style>
    </head>
    <body>
      <h1>🔮 Oracle API Documentation</h1>

      <h2>Available Endpoints</h2>
      "#;

const TEMPLATE_TAIL: &str = r#"

      <h2>Service Information</h2>
      <p>This Oracle API provides game completion services for Solana-based coinflip games.</p>
    </body>
  </html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_routes() {
        let html = generate_documentation_html(&[RouteDocumentation {
            path: "/a<b>",
            method: HttpMethod::Post,
            summary: "Tom & \"Jerry\"",
            request_example: Some("{ 'x': 1 }"),
        }]);
        assert!(html.contains(r#"<span class="method post">POST</span> <code>/a&lt;b&gt;</code>"#));
        assert!(html.contains("Tom &amp; &quot;Jerry&quot;<br><strong>Body:</strong> <code>{ &#39;x&#39;: 1 }</code>"));
        assert!(html.starts_with("\n  <!DOCTYPE html>"));
    }
}
