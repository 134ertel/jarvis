interface PlaceholderViewProps {
  title: string;
  description: string;
}

export default function PlaceholderView({ title, description }: PlaceholderViewProps): JSX.Element {
  return (
    <div className="placeholder-view glass-panel">
      <div className="placeholder-ring" />
      <h2>{title}</h2>
      <p>{description}</p>
      <span className="placeholder-tag">Not yet connected</span>
    </div>
  );
}
